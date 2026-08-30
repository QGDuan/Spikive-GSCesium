import {
  Entity,
  InputFrame,
  KeyboardMouseSource,
  OrbitController,
  Pose,
  Quat,
  Vec2,
  Vec3
} from 'playcanvas';
import {
  createLevelFirstPersonPose,
  resolveFirstPersonMovement,
  updateFirstPersonLook
} from './camera-orientation';
import {
  THIRD_PERSON_DEFAULT_DISTANCE_METERS,
  THIRD_PERSON_DEFAULT_HEIGHT_METERS,
  type CameraMode
} from './camera-mode';

const ORBIT_ROTATE_SPEED = 0.2;
const ZOOM_SPEED = 0.001;
const FIRST_PERSON_MOVE_SPEED = 4;
const FIRST_PERSON_FAST_SPEED = 8;
const FIRST_PERSON_SLOW_SPEED = 1.5;
const THIRD_PERSON_INITIAL_PITCH_DEGREES = 35;

const tmpDesired = new Vec3();
const tmpPan = new Vec3();
const tmpRotation = new Quat();

interface NavigationState {
  axis: Vec3;
  buttons: number[];
  shift: number;
  ctrl: number;
}

const createState = (): NavigationState => ({
  axis: new Vec3(),
  buttons: [0, 0, 0],
  shift: 0,
  ctrl: 0
});

/**
 * One-camera navigation built from PlayCanvas' public input, Pose and OrbitController.
 * First-person mouse/WASD math follows the official FirstPersonController, while direct camera
 * movement replaces its rigidbody-only step because this GS viewer has no frontend collision
 * proxy. The official character controller is deliberately not mounted without Ammo, a capsule
 * rigidbody and a real collision mesh.
 */
export class InspectionCameraNavigation {
  private readonly canvas: HTMLCanvasElement;
  private readonly camera: Entity;
  private readonly thirdPersonInput = new KeyboardMouseSource();
  private readonly firstPersonInput = new KeyboardMouseSource({ pointerLock: true });
  private readonly orbitController = new OrbitController();
  private readonly frame = new InputFrame({ move: [0, 0, 0], rotate: [0, 0, 0] });
  private readonly state = createState();
  private readonly pose = new Pose();
  private readonly thirdPersonPose = new Pose();
  private mode: CameraMode = 'third-person';
  private input = this.thirdPersonInput;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, camera: Entity) {
    this.canvas = canvas;
    this.camera = camera;
    this.orbitController.rotateDamping = 0.98;
    this.orbitController.moveDamping = 0.98;
    this.orbitController.zoomDamping = 0.98;
    this.orbitController.pitchRange = new Vec2(-75, 75);
    this.orbitController.zoomRange = new Vec2(0.5, 10_000);
    this.input.attach(this.canvas);
    this.resetThirdPerson(Vec3.ZERO, 10_000);
  }

  get cameraMode() {
    return this.mode;
  }

  setCameraMode(mode: CameraMode) {
    if (this.disposed || mode === this.mode) return;

    if (this.mode === 'third-person') {
      this.thirdPersonPose.copy(this.pose);
      this.orbitController.detach();
    }
    this.input.detach();
    this.resetInputState();
    this.mode = mode;

    if (mode === 'first-person') {
      createLevelFirstPersonPose(
        this.camera.getPosition(),
        this.camera.forward,
        this.camera.getEulerAngles().y,
        this.pose
      );
      this.input = this.firstPersonInput;
    } else {
      if (document.pointerLockElement === this.canvas) void document.exitPointerLock();
      this.pose.copy(this.thirdPersonPose);
      this.orbitController.attach(this.pose, false);
      this.input = this.thirdPersonInput;
    }
    this.input.attach(this.canvas);
    this.applyPose();
  }

  requestPointerLock() {
    if (this.disposed || this.mode !== 'first-person') return false;
    if (document.pointerLockElement === this.canvas) return true;
    try {
      void Promise.resolve(this.canvas.requestPointerLock()).catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }

  /** Reset the OrbitCamera-equivalent view around a scene-local anchor. */
  resetThirdPerson(anchor: Vec3, maximumDistance: number) {
    const focus = anchor.clone().add(Vec3.UP.clone().mulScalar(THIRD_PERSON_DEFAULT_HEIGHT_METERS));
    const orbitRotation = new Quat().setFromEulerAngles(-THIRD_PERSON_INITIAL_PITCH_DEGREES, 0, 0);
    const position = orbitRotation.transformVector(Vec3.BACK, new Vec3())
      .mulScalar(THIRD_PERSON_DEFAULT_DISTANCE_METERS)
      .add(focus);
    const initialPose = new Pose().look(position, focus);
    this.orbitController.zoomRange = new Vec2(0.5, Math.max(maximumDistance, THIRD_PERSON_DEFAULT_DISTANCE_METERS));
    this.thirdPersonPose.copy(initialPose);

    if (this.mode === 'third-person') {
      this.pose.copy(initialPose);
      this.orbitController.attach(this.pose, false);
      this.applyPose();
    }
  }

  /** Preserve the old Orbit view, then enter first-person at a normal-driven observation pose. */
  focusFirstPerson(target: Vec3, position: Vec3) {
    this.setCameraMode('first-person');
    this.pose.look(position, target);
    this.applyPose();
  }

  releasePointerLock() {
    if (document.pointerLockElement !== this.canvas) return false;
    void document.exitPointerLock();
    return true;
  }

  update(deltaTime: number) {
    if (this.disposed) return;
    const dt = Math.min(deltaTime, 0.1);
    const { keyCode } = KeyboardMouseSource;
    const { key, button, mouse, wheel } = this.input.read();

    this.state.axis.add(tmpDesired.set(
      (key[keyCode.D] - key[keyCode.A]) + (key[keyCode.RIGHT] - key[keyCode.LEFT]),
      // Product convention: Q raises world height and E lowers it.
      key[keyCode.Q] - key[keyCode.E],
      (key[keyCode.W] - key[keyCode.S]) + (key[keyCode.UP] - key[keyCode.DOWN])
    ));
    for (let index = 0; index < this.state.buttons.length; index += 1) {
      this.state.buttons[index] += button[index];
    }
    this.state.shift += key[keyCode.SHIFT];
    this.state.ctrl += key[keyCode.CTRL];

    if (this.mode === 'first-person') {
      this.updateFirstPerson(dt, mouse);
    } else {
      this.updateThirdPerson(dt, mouse, wheel[0]);
    }
    this.applyPose();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.releasePointerLock();
    this.thirdPersonInput.destroy();
    this.firstPersonInput.destroy();
    this.orbitController.destroy();
  }

  private updateFirstPerson(dt: number, mouse: number[]) {
    const speed = (this.state.shift
      ? FIRST_PERSON_FAST_SPEED
      : this.state.ctrl
        ? FIRST_PERSON_SLOW_SPEED
        : FIRST_PERSON_MOVE_SPEED) * dt;

    // Match PlayCanvas FirstPersonController: mouse X changes yaw, mouse Y changes pitch,
    // and pitch is bounded before movement is resolved.
    updateFirstPersonLook(this.pose.angles, mouse[0], mouse[1], dt);

    // Match the official controller's movement basis exactly: WASD follows yaw only, never the
    // inherited Orbit pitch. D-A drives right/left and W-S drives forward/back. Q/E is the one
    // product-specific extension and remains true world-up/world-down.
    resolveFirstPersonMovement(this.state.axis, this.pose.angles.y, speed, tmpDesired);
    this.pose.position.add(tmpDesired);
  }

  private updateThirdPerson(dt: number, mouse: number[], wheel: number) {
    const pan = Boolean(this.state.shift || this.state.buttons[1]);
    if (pan) {
      this.screenToOrbitPan(mouse[0], mouse[1], this.pose.distance, tmpPan);
      this.frame.deltas.move.append([tmpPan.x, tmpPan.y, 0]);
    }
    this.frame.deltas.move.append([0, 0, wheel * ZOOM_SPEED]);
    if (!pan) {
      this.frame.deltas.rotate.append([mouse[0] * ORBIT_ROTATE_SPEED, mouse[1] * ORBIT_ROTATE_SPEED, 0]);
    }
    this.pose.copy(this.orbitController.update(this.frame, dt));
    this.thirdPersonPose.copy(this.pose);
  }

  /** Same perspective pan conversion used by PlayCanvas CameraControls. */
  private screenToOrbitPan(dx: number, dy: number, distance: number, out: Vec3) {
    const camera = this.camera.camera;
    if (!camera) return out.set(0, 0, 0);
    const rect = this.canvas.getBoundingClientRect();
    const halfHeight = distance * Math.tan(camera.fov * Math.PI / 360);
    return out.set(
      -(dx / Math.max(rect.width, 1)) * 2 * halfHeight * camera.aspectRatio,
      (dy / Math.max(rect.height, 1)) * 2 * halfHeight,
      0
    );
  }

  private applyPose() {
    this.camera.setPosition(this.pose.position);
    this.camera.setEulerAngles(this.pose.angles);
  }

  private resetInputState() {
    this.state.axis.set(0, 0, 0);
    this.state.buttons.fill(0);
    this.state.shift = 0;
    this.state.ctrl = 0;
    this.frame.read();
  }
}
