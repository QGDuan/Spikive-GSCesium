import { useEffect, useRef, useState } from "react";
import {
  BoundingSphere, Cartesian2, Cartesian3, Cesium3DTileset, Color, EllipsoidTerrainProvider, HeadingPitchRange, LabelStyle, Math as CesiumMath, Matrix4,
  OpenStreetMapImageryProvider, PolylineGlowMaterialProperty, ScreenSpaceEventHandler,
  ScreenSpaceEventType, Transforms, Viewer, VerticalOrigin
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import type { Dataset, InspectionLabel, Mission, SurfaceHit } from "@spikive/shared";
import { api } from "./api";
import { localToWorld, placementMatrix } from "./cesium-utils";
import { routeWaypointVisual } from "./route-visuals";
import { inspectionLabelIdFromPick } from "./inspection-label-selection";
import { createGsRevealController } from "./gs-reveal-controller";
import { easeOutGsReveal, GS_REVEAL_DURATION_MS } from "./gs-reveal-policy";
import { GS_STABLE_TILE_POLICY, resolutionScaleForDevice } from "./gs-tiles-policy";

interface Props {
  dataset: Dataset | null;
  labels: InspectionLabel[];
  mission: Mission | null;
  labelMode: boolean;
  pendingPick: SurfaceHit | null;
  selectedLabelId: string | null;
  focusRequest: { datasetId: string; sequence: number } | null;
  onPickLabel(hit: SurfaceHit): void;
  onSelectLabel(labelId: string): void;
  onMessage(message: string): void;
}

interface PickProbe { x: number; y: number }

export function CesiumScene({
  dataset, labels, mission, labelMode, pendingPick, selectedLabelId, focusRequest, onPickLabel, onSelectLabel, onMessage
}: Props) {
  const container = useRef<HTMLDivElement>(null); const viewerRef = useRef<Viewer | null>(null); const tilesetRef = useRef<Cesium3DTileset | null>(null);
  const introCancelRef = useRef<(() => void) | null>(null); const introActiveRef = useRef(false); const [introActive, setIntroActive] = useState(false);
  const [pickProbe, setPickProbe] = useState<PickProbe | null>(null);
  const [tilesRevision, setTilesRevision] = useState<string | null>(null);
  const messageRef = useRef(onMessage);
  const focusRequestRef = useRef(focusRequest);
  const handledFocusSequenceRef = useRef(0);
  const placementKey = dataset ? [
    dataset.placement.longitude, dataset.placement.latitude, dataset.placement.height,
    dataset.placement.heading, dataset.placement.pitch, dataset.placement.roll, dataset.placement.scale
  ].join(":") : "";

  useEffect(() => { messageRef.current = onMessage; }, [onMessage]);
  focusRequestRef.current = focusRequest;
  useEffect(() => { setPickProbe(null); }, [labelMode, dataset?.id]);
  useEffect(() => {
    if (!dataset || !["ready", "rebuilding"].includes(dataset.status)) {
      setTilesRevision(null);
      return;
    }
    const prefix = `${dataset.id}:`;
    const visualRevision = dataset.activeVisualRevision ?? dataset.updatedAt;
    setTilesRevision(current => dataset.status === "rebuilding" && current?.startsWith(prefix)
      ? current
      : `${prefix}${visualRevision}`);
  }, [dataset?.id, dataset?.status, dataset?.activeVisualRevision, dataset?.updatedAt]);

  useEffect(() => {
    if (!container.current) return;
    const viewer = new Viewer(container.current, {
      baseLayerPicker: false, baseLayer: false, terrainProvider: new EllipsoidTerrainProvider(), animation: false,
      timeline: false, geocoder: false, homeButton: false, sceneModePicker: false,
      navigationHelpButton: false, selectionIndicator: false, infoBox: false,
      showRenderLoopErrors: false, useBrowserRecommendedResolution: false
    });
    viewer.resolutionScale = resolutionScaleForDevice(window.devicePixelRatio);
    viewer.imageryLayers.addImageryProvider(new OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" }));
    // Cesium's experimental Gaussian renderer does not expose native feature or
    // depth picking. Keep the problematic translucent-depth pass disabled; label
    // clicks are resolved against the published collision voxels instead.
    viewer.scene.pickTranslucentDepth = false; viewer.scene.globe.depthTestAgainstTerrain = true; viewerRef.current = viewer;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined; const recentFailures: number[] = [];
    const recoverRenderLoop = (_scene: unknown, error: unknown) => {
      const now = Date.now(); recentFailures.push(now);
      while (recentFailures.length && now - recentFailures[0]! > 5000) recentFailures.shift();
      console.error("[Spikive][Cesium renderError]", error);
      introCancelRef.current?.();
      viewer.scene.pickTranslucentDepth = false;
      const tileset = tilesetRef.current;
      if (tileset && !tileset.isDestroyed()) {
        // Rendering failures must never silently lower the fixed visual quality.
        tileset.maximumScreenSpaceError = GS_STABLE_TILE_POLICY.maximumScreenSpaceError;
        tileset.dynamicScreenSpaceError = GS_STABLE_TILE_POLICY.dynamicScreenSpaceError;
        tileset.cullRequestsWhileMoving = GS_STABLE_TILE_POLICY.cullRequestsWhileMoving;
      }
      if (recentFailures.length > 3) {
        viewer.cesiumWidget.useDefaultRenderLoop = false;
        messageRef.current(`${tileset ? "GS" : "Cesium 场景"}连续渲染失败，已停止自动重试且未降低画质；请清除显示后重新选择模型`);
        return;
      }
      messageRef.current(tileset
        ? "GS LOD 切换出现瞬时资源冲突，正在按固定高清策略恢复渲染…"
        : "Cesium 场景出现瞬时渲染异常，正在恢复…");
      if (recoveryTimer) clearTimeout(recoveryTimer);
      recoveryTimer = setTimeout(() => {
        recoveryTimer = undefined;
        if (viewer.isDestroyed() || viewer.scene.isDestroyed()) return;
        viewer.scene.requestRender();
        viewer.cesiumWidget.useDefaultRenderLoop = true;
      }, 80);
    };
    viewer.scene.renderError.addEventListener(recoverRenderLoop);
    return () => {
      if (recoveryTimer) clearTimeout(recoveryTimer);
      introCancelRef.current?.();
      if (!viewer.isDestroyed()) viewer.scene.renderError.removeEventListener(recoverRenderLoop);
      if (viewerRef.current === viewer) {
        viewerRef.current = null;
        tilesetRef.current = null;
      }
      if (!viewer.isDestroyed()) viewer.destroy();
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current; if (!viewer || viewer.isDestroyed()) return;
    if (!dataset || !tilesRevision?.startsWith(`${dataset.id}:`)) return;
    let cancelled = false; let ownedTileset: Cesium3DTileset | null = null; let finishIntro: ((message?: string) => void) | null = null; let releaseIntroDiagnostics: (() => void) | null = null;
    void Cesium3DTileset.fromUrl(`/api/datasets/${dataset.id}/tiles/tileset.json?revision=${encodeURIComponent(tilesRevision)}`, {
      maximumScreenSpaceError: GS_INTRO_POLICY.maximumScreenSpaceError,
      cacheBytes: GS_INTRO_POLICY.cacheBytes,
      maximumCacheOverflowBytes: GS_INTRO_POLICY.maximumCacheOverflowBytes,
      cullRequestsWhileMoving: false,
      dynamicScreenSpaceError: false,
      foveatedScreenSpaceError: true,
      foveatedConeSize: GS_INTRO_POLICY.foveatedConeSize,
      foveatedMinimumScreenSpaceErrorRelaxation: GS_INTRO_POLICY.foveatedMinimumScreenSpaceErrorRelaxation,
      foveatedTimeDelay: GS_INTRO_POLICY.foveatedTimeDelay,
      progressiveResolutionHeightFraction: GS_INTRO_POLICY.progressiveResolutionHeightFraction,
      skipLevelOfDetail: false,
      loadSiblings: false
    }).then(tileset => {
      if (cancelled || viewer.isDestroyed()) { if (!tileset.isDestroyed()) tileset.destroy(); return; }
      viewer.cesiumWidget.useDefaultRenderLoop = true;
      ownedTileset = tileset; tilesetRef.current = tileset;

      const sphere = BoundingSphere.clone(tileset.boundingSphere);
      const orbitTransform = Transforms.eastNorthUpToFixedFrame(sphere.center);
      const orbitRange = Math.max(sphere.radius * 2.2, 20);
      const revealController = createGsRevealController(tileset, sphere.radius);
      const controller = viewer.scene.screenSpaceCameraController;
      let finished = false; let animationStarted = false; let initialTilesReady = false; let minimumDurationReached = false;
      let animationFrame: number | undefined; let firstTileTimeout: ReturnType<typeof setTimeout> | undefined; let maximumDurationTimeout: ReturnType<typeof setTimeout> | undefined;
      let shaderReleaseTimer: ReturnType<typeof setTimeout> | undefined;
      let removeTileLoad: (() => void) | undefined; let removeInitialTilesLoaded: (() => void) | undefined;
      releaseIntroDiagnostics = () => {
        if (shaderReleaseTimer) clearTimeout(shaderReleaseTimer);
        shaderReleaseTimer = undefined;
      };
      const applyQueuedFocus = () => {
        const request = focusRequestRef.current;
        if (!request || request.datasetId !== dataset.id || request.sequence <= handledFocusSequenceRef.current) return;
        if (viewer.isDestroyed() || tileset.isDestroyed() || introActiveRef.current) return;
        focusTileset(viewer, tileset);
        handledFocusSequenceRef.current = request.sequence;
        messageRef.current("已定位到 GS 数据");
      };

      const verifyShaderRelease = (attempt: number) => {
        shaderReleaseTimer = undefined;
        if (cancelled || viewer.isDestroyed() || tileset.isDestroyed() || !revealController.shaderActive) return;
        viewer.scene.requestRender();
        if (attempt < 2) {
          shaderReleaseTimer = setTimeout(() => verifyShaderRelease(attempt + 1), 100);
          return;
        }
        console.error("[Spikive][GS Reveal] 标准 Shader 恢复确认超时", { datasetId: dataset.id });
        messageRef.current("GS 入场 Shader 恢复延迟，已请求 Cesium 重新渲染；请留意控制台");
      };

      const restoreNormalTileset = () => {
        revealController.finish();
        if (tileset.isDestroyed()) return;
        tileset.maximumScreenSpaceError = GS_STABLE_TILE_POLICY.maximumScreenSpaceError;
        tileset.dynamicScreenSpaceError = GS_STABLE_TILE_POLICY.dynamicScreenSpaceError;
        tileset.foveatedScreenSpaceError = GS_STABLE_TILE_POLICY.foveatedScreenSpaceError;
        tileset.progressiveResolutionHeightFraction = GS_STABLE_TILE_POLICY.progressiveResolutionHeightFraction;
      };
      const completeIntro = (message?: string) => {
        if (finished) return; finished = true;
        if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
        if (firstTileTimeout) clearTimeout(firstTileTimeout);
        if (maximumDurationTimeout) clearTimeout(maximumDurationTimeout);
        releaseIntroDiagnostics?.();
        removeTileLoad?.(); removeInitialTilesLoaded?.();
        restoreNormalTileset();
        if (!viewer.isDestroyed()) {
          viewer.camera.lookAtTransform(Matrix4.IDENTITY);
          controller.enableInputs = true;
          viewer.scene.requestRender();
          if (!cancelled) shaderReleaseTimer = setTimeout(() => verifyShaderRelease(0), 100);
        }
        introActiveRef.current = false; setIntroActive(false);
        if (!cancelled) applyQueuedFocus();
        if (introCancelRef.current === cancelIntro) introCancelRef.current = null;
        if (message && !cancelled) onMessage(message);
      };
      const cancelIntro = () => completeIntro();
      finishIntro = completeIntro; introCancelRef.current = cancelIntro;

      const finishWhenReady = () => {
        if (minimumDurationReached && initialTilesReady) completeIntro("GS 初始化完成，可自由浏览");
      };
      const startAnimation = () => {
        if (animationStarted || finished) return; animationStarted = true;
        if (firstTileTimeout) { clearTimeout(firstTileTimeout); firstTileTimeout = undefined; }
        removeTileLoad?.(); removeTileLoad = undefined;
        if (!revealController.supported) {
          completeIntro("当前 Cesium GS 渲染器不支持种子生长效果，已恢复标准浏览");
          return;
        }
        const startedAt = performance.now();
        let lastCameraUpdate = Number.NEGATIVE_INFINITY;
        let lastFrameAt = startedAt;
        let slowFrameStreak = 0;
        maximumDurationTimeout = setTimeout(() => completeIntro("GS 初始化展示完成，可自由浏览"), GS_INTRO_POLICY.maximumDurationMs);
        const animate = (now: number) => {
          if (finished) return;
          if (viewer.isDestroyed() || tileset.isDestroyed()) { completeIntro(); return; }
          const frameInterval = now - lastFrameAt;
          lastFrameAt = now;
          if (document.visibilityState === "visible" && frameInterval > GS_INTRO_POLICY.slowFrameThresholdMs) slowFrameStreak += 1;
          else slowFrameStreak = 0;
          if (slowFrameStreak >= GS_INTRO_POLICY.slowFrameLimit) {
            completeIntro("设备渲染压力较高，已关闭入场效果并恢复标准 GS 浏览");
            return;
          }
          revealController.update(now - startedAt);
          const progress = Math.min((now - startedAt) / GS_INTRO_POLICY.minimumDurationMs, 1);
          if (progress === 1 || now - lastCameraUpdate >= GS_INTRO_POLICY.cameraUpdateIntervalMs) {
            lastCameraUpdate = now;
            const orbitProgress = easeOrbitProgress(progress, GS_INTRO_POLICY.easingRamp);
            const phase = CesiumMath.TWO_PI * progress;
            const pitch = GS_INTRO_POLICY.basePitch + GS_INTRO_POLICY.pitchAmplitude
              * Math.sin(phase + GS_INTRO_POLICY.pitchPhaseOffset);
            const rangeScale = 1
              + GS_INTRO_POLICY.rangeWaveAmplitude * Math.sin(phase)
              + GS_INTRO_POLICY.rangeArcAmplitude * Math.sin(Math.PI * progress);
            const expansion = easeOutGsReveal(progress);
            tileset.foveatedConeSize = GS_INTRO_POLICY.foveatedConeSize
              + (1 - GS_INTRO_POLICY.foveatedConeSize) * expansion;
            tileset.foveatedMinimumScreenSpaceErrorRelaxation
              = GS_INTRO_POLICY.foveatedMinimumScreenSpaceErrorRelaxation * (1 - expansion);
            viewer.camera.lookAtTransform(orbitTransform, new HeadingPitchRange(
              GS_INTRO_POLICY.startHeading + GS_INTRO_POLICY.rotationAngle * orbitProgress,
              pitch,
              orbitRange * rangeScale
            ));
            viewer.scene.requestRender();
          }
          if (progress < 1) animationFrame = requestAnimationFrame(animate);
          else { animationFrame = undefined; minimumDurationReached = true; finishWhenReady(); }
        };
        animationFrame = requestAnimationFrame(animate);
      };

      controller.enableInputs = false; introActiveRef.current = true; setIntroActive(true);
      const initialPitch = GS_INTRO_POLICY.basePitch + GS_INTRO_POLICY.pitchAmplitude
        * Math.sin(GS_INTRO_POLICY.pitchPhaseOffset);
      viewer.camera.lookAtTransform(orbitTransform, new HeadingPitchRange(GS_INTRO_POLICY.startHeading, initialPitch, orbitRange));
      removeTileLoad = tileset.tileLoad.addEventListener(startAnimation);
      removeInitialTilesLoaded = tileset.initialTilesLoaded.addEventListener(() => { initialTilesReady = true; finishWhenReady(); });
      firstTileTimeout = setTimeout(() => completeIntro("GS 首屏加载较慢，已恢复自由浏览"), GS_INTRO_POLICY.firstTileTimeoutMs);
      viewer.scene.primitives.add(tileset);
      onMessage("GS 初始化展示中：全场种子以统一尺度出现，Gaussian 尺度与 Alpha 在 20 秒内从中心向外持续生长；期间暂时锁定操作");
    }).catch(error => { if (!cancelled) onMessage(`GS 加载失败：${String(error)}`); });
    return () => {
      cancelled = true; finishIntro?.(); releaseIntroDiagnostics?.();
      const tileset = ownedTileset;
      if (!tileset) return;
      if (tilesetRef.current === tileset) tilesetRef.current = null;
      if (!viewer.isDestroyed() && viewer.scene.primitives.contains(tileset)) viewer.scene.primitives.remove(tileset);
      else if (!tileset.isDestroyed()) tileset.destroy();
    };
  }, [dataset?.id, tilesRevision, placementKey]);

  useEffect(() => {
    if (!focusRequest || focusRequest.datasetId !== dataset?.id || focusRequest.sequence <= handledFocusSequenceRef.current) return;
    const viewer = viewerRef.current; const tileset = tilesetRef.current;
    if (!viewer || viewer.isDestroyed() || !tileset || tileset.isDestroyed()) {
      messageRef.current("GS 数据尚未加载完成，定位请求已排队");
      return;
    }
    if (introActiveRef.current) { messageRef.current("GS 正在初始化环绕展示，定位将在解锁后执行"); return; }
    focusTileset(viewer, tileset);
    handledFocusSequenceRef.current = focusRequest.sequence;
    messageRef.current("已定位到 GS 数据");
  }, [dataset?.id, focusRequest]);

  useEffect(() => {
    const viewer = viewerRef.current; if (!viewer || viewer.isDestroyed()) return;
    for (const entity of [...viewer.entities.values]) if (String(entity.id).startsWith("app:")) viewer.entities.remove(entity);
    if (!dataset) return; const transform = placementMatrix(dataset.placement);
    const sceneLabels = labels.filter(label => label.datasetId === dataset.id);
    const sceneMission = mission?.datasetId === dataset.id ? mission : null;
    if (pendingPick) {
      const position = localToWorld(pendingPick.position, transform);
      viewer.entities.add({
        id: "app:pending-label-halo",
        position,
        point: {
          pixelSize: 27,
          color: Color.fromCssColorString("#ff8a00").withAlpha(0.28),
          outlineColor: Color.WHITE.withAlpha(0.9),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
      const normalEnd = {
        x: pendingPick.position.x + pendingPick.normal.x,
        y: pendingPick.position.y + pendingPick.normal.y,
        z: pendingPick.position.z + pendingPick.normal.z
      };
      viewer.entities.add({
        id: "app:pending-label-normal",
        polyline: { positions: [position, localToWorld(normalEnd, transform)], width: 3, material: Color.fromCssColorString("#ff7900") }
      });
      viewer.entities.add({
        id: "app:pending-label",
        name: "待保存标签",
        position,
        point: {
          pixelSize: 12,
          color: Color.fromCssColorString("#ff7900"),
          outlineColor: Color.WHITE,
          outlineWidth: 3,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        },
        label: {
          text: "待保存标签",
          font: "bold 13px sans-serif",
          fillColor: Color.fromCssColorString("#24272b"),
          showBackground: true,
          backgroundColor: Color.WHITE.withAlpha(0.9),
          backgroundPadding: new Cartesian2(7, 5),
          style: LabelStyle.FILL,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, -20),
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
    }
    for (const label of sceneLabels) {
      const position = localToWorld(label.positionLocal, transform);
      const selected = label.id === selectedLabelId;
      if (selected) viewer.entities.add({
        id: `app:label-highlight:${label.id}`,
        position,
        point: {
          pixelSize: 27,
          color: Color.fromCssColorString("#0b63f6").withAlpha(0.25),
          outlineColor: Color.fromCssColorString("#0b63f6"),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
      viewer.entities.add({
        id: `app:label:${label.id}`,
        name: label.title,
        position,
        point: {
          pixelSize: selected ? 15 : 11,
          color: Color.fromCssColorString(label.color),
          outlineColor: selected ? Color.fromCssColorString("#0b63f6") : Color.WHITE,
          outlineWidth: selected ? 4 : 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        },
        label: {
          text: label.title,
          font: selected ? "bold 14px sans-serif" : "14px sans-serif",
          fillColor: selected ? Color.fromCssColorString("#111318") : Color.WHITE,
          showBackground: selected,
          backgroundColor: Color.WHITE.withAlpha(0.94),
          backgroundPadding: new Cartesian2(7, 5),
          style: LabelStyle.FILL_AND_OUTLINE,
          outlineColor: selected ? Color.WHITE : Color.BLACK,
          outlineWidth: selected ? 2 : 3,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, selected ? -19 : -14),
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
      if (label.surfaceNormalLocal) {
        const end = { x: label.positionLocal.x + label.surfaceNormalLocal.x, y: label.positionLocal.y + label.surfaceNormalLocal.y, z: label.positionLocal.z + label.surfaceNormalLocal.z };
        viewer.entities.add({ id: `app:normal:${label.id}`, polyline: { positions: [position, localToWorld(end, transform)], width: 3, material: Color.ORANGE } });
      }
    }
    if (sceneMission?.waypoints.length) {
      const positions = sceneMission.waypoints.map(point => localToWorld(point.positionLocal, transform));
      const labelsById = new Map(sceneLabels.map(label => [label.id, label]));
      const routeColor = sceneMission.status === "valid" ? Color.LIME : Color.fromCssColorString("#ff7900");
      viewer.entities.add({ id: `app:route:${sceneMission.id}`, name: sceneMission.status === "valid" ? "已复检航线" : "未完成航线 · 安全前缀预览", polyline: { positions, width: 5, material: new PolylineGlowMaterialProperty({ color: routeColor, glowPower: 0.2 }) } });
      sceneMission.waypoints.forEach((point, index) => {
        const targetLabel = point.targetLabelId ? labelsById.get(point.targetLabelId) : undefined;
        const visual = routeWaypointVisual(point, index, targetLabel?.title);
        const waypointColor = Color.fromCssColorString(visual.color);
        viewer.entities.add({
          id: `app:waypoint:${point.id}`,
          name: visual.name,
          position: positions[index],
          point: {
            pixelSize: visual.pixelSize,
            color: waypointColor,
            outlineColor: Color.WHITE,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          },
          label: visual.showText ? {
            text: visual.name,
            font: "12px sans-serif",
            fillColor: waypointColor,
            style: LabelStyle.FILL_AND_OUTLINE,
            outlineColor: Color.WHITE,
            outlineWidth: 3,
            pixelOffset: new Cartesian2(0, -13),
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          } : undefined
        });
      });
    }
  }, [dataset?.id, placementKey, labels, mission, pendingPick, selectedLabelId]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || !dataset || labelMode) return;
    const selectableIds = new Set(labels.filter(label => label.datasetId === dataset.id).map(label => label.id));
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((event: { position: Cartesian2 }) => {
      if (introActiveRef.current) return;
      // Entity picking is used only for the explicit annotation overlay. GS
      // surface geometry and normals continue to come from the backend SVO.
      const labelId = inspectionLabelIdFromPick(viewer.scene.pick(event.position));
      if (labelId && selectableIds.has(labelId)) onSelectLabel(labelId);
    }, ScreenSpaceEventType.LEFT_CLICK);
    return () => handler.destroy();
  }, [dataset?.id, labelMode, labels, onSelectLabel]);

  useEffect(() => {
    const viewer = viewerRef.current; if (!viewer || viewer.isDestroyed() || !dataset || !labelMode) return;
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas); const transform = placementMatrix(dataset.placement);
    const inverseTransform = Matrix4.inverse(transform, new Matrix4());
    let cancelled = false; let picking = false;
    handler.setInputAction(async (event: { position: Cartesian2 }) => {
      if (introActiveRef.current) { onMessage("GS 初始化展示尚未结束，请稍后再拾取标签"); return; }
      const tileset = tilesetRef.current;
      if (!tileset || tileset.isDestroyed()) { onMessage("GS 数据尚未加载完成"); return; }
      const ray = viewer.camera.getPickRay(event.position);
      if (!ray || picking) return;
      const localOrigin = Matrix4.multiplyByPoint(inverseTransform, ray.origin, new Cartesian3());
      const localDirection = Matrix4.multiplyByPointAsVector(inverseTransform, ray.direction, new Cartesian3());
      if (Cartesian3.magnitudeSquared(localDirection) < 1e-12) { onMessage("无法生成有效拾取射线"); return; }
      Cartesian3.normalize(localDirection, localDirection);
      picking = true;
      setPickProbe({ x: event.position.x, y: event.position.y });
      onMessage("正在解析 GS 表面，点击位置已标记…");
      try {
        const hit = await api.raycastDataset(dataset.id, {
          originLocal: { x: localOrigin.x, y: localOrigin.y, z: localOrigin.z },
          directionLocal: { x: localDirection.x, y: localDirection.y, z: localDirection.z }
        });
        if (cancelled) return;
        if (!hit) { onMessage("该位置未命中 GS 表面，请点击可见模型区域"); return; }
        onPickLabel(hit);
      } catch (error) {
        if (!cancelled) onMessage(`GS 拾取失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        picking = false;
        if (!cancelled) setPickProbe(null);
      }
    }, ScreenSpaceEventType.LEFT_CLICK);
    return () => { cancelled = true; handler.destroy(); };
  }, [dataset?.id, placementKey, labelMode, onPickLabel, onMessage]);

  return <>
    <div ref={container} className={`cesium-scene${labelMode ? " is-picking" : ""}`} />
    {pickProbe && <div className="gs-pick-probe" style={{ left: pickProbe.x, top: pickProbe.y }} role="status" aria-label="正在解析点击位置"><i /></div>}
    {introActive && <div className="gs-intro-status" role="status" aria-live="polite"><i />GS 初始化 · 尺度成长 · 中心扩散 · 斜向环绕</div>}
  </>;
}

const GS_INTRO_POLICY = Object.freeze({
  maximumScreenSpaceError: 24,
  progressiveResolutionHeightFraction: 0.3,
  foveatedConeSize: 0.06,
  foveatedMinimumScreenSpaceErrorRelaxation: 12,
  foveatedTimeDelay: 0.35,
  cacheBytes: 384 * 1024 * 1024,
  maximumCacheOverflowBytes: 128 * 1024 * 1024,
  startHeading: CesiumMath.toRadians(-36),
  rotationAngle: -CesiumMath.TWO_PI * 1.5,
  basePitch: CesiumMath.toRadians(-27),
  pitchAmplitude: CesiumMath.toRadians(7),
  pitchPhaseOffset: -Math.PI / 4,
  rangeWaveAmplitude: 0.14,
  rangeArcAmplitude: 0.08,
  easingRamp: 0.12,
  cameraUpdateIntervalMs: 1000 / 30,
  minimumDurationMs: GS_REVEAL_DURATION_MS,
  maximumDurationMs: 20500,
  firstTileTimeoutMs: 10000,
  slowFrameThresholdMs: 100,
  slowFrameLimit: 10
});

function easeOrbitProgress(progress: number, ramp: number) {
  if (progress <= ramp) return progress * progress / (2 * ramp * (1 - ramp));
  if (progress >= 1 - ramp) {
    const remaining = 1 - progress;
    return 1 - remaining * remaining / (2 * ramp * (1 - ramp));
  }
  return (progress - ramp / 2) / (1 - ramp);
}

function focusTileset(viewer: Viewer, tileset: Cesium3DTileset) {
  const sphere = BoundingSphere.clone(tileset.boundingSphere);
  viewer.camera.viewBoundingSphere(sphere, new HeadingPitchRange(0, -0.35, Math.max(sphere.radius * 2.2, 20)));
  viewer.camera.lookAtTransform(Matrix4.IDENTITY);
}
