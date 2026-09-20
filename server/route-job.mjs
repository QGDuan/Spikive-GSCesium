import { Worker } from 'node:worker_threads';

let running = false;
export const isPlanning = () => running;
export const planInWorker = async (directory, input, manifestSha256) => {
  if (running) throw Object.assign(new Error('已有航线正在规划，请等待完成。'), { statusCode: 409 });
  running = true;
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./route-worker.mjs', import.meta.url), {
        workerData: { directory, input, manifestSha256 }
      });
      let message;
      let failure;
      const timer = setTimeout(() => {
        failure = new Error('航线规划超过五分钟，已终止。');
        void worker.terminate();
      }, 5 * 60_000);
      worker.once('message', (value) => {
        message = value;
      });
      worker.once('error', (error) => {
        failure = error;
      });
      worker.once('exit', (code) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (code !== 0 || !message) reject(new Error('航线工作线程异常退出。'));
        else if (message.error) reject(new Error(message.error));
        else resolve(message.result);
      });
    });
  } finally {
    running = false;
  }
};
