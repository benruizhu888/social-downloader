/**
 * 并发限制的小工具（无依赖，纯 Node 可单测）
 *
 * 为什么不用 Promise.all 直接铺开：采集与转封装都要起真实的浏览器窗口 /
 * ffmpeg 子进程，同时开 10 个会把内存与 CPU 打满（真机上表现为「越下越慢」，
 * 甚至 GPU 进程被挤掉）。而完全串行又浪费 —— 一个窗口等 12 秒、下一个才开始。
 *
 * 语义与 `Promise.all` 的差别：
 *   · 结果数组**按输入顺序**返回（不是完成顺序）—— 调用方多半要按原顺序拼日志；
 *   · 任一任务抛错 → 整体 reject（与 Promise.all 一致）。调用方若想「一条失败不影响其它」，
 *     就在 fn 内部自己 try/catch（本项目里 runTargets 就是这么做的）。
 */

/**
 * 以最多 `limit` 个并发跑完 `list`。
 *
 * @template T, R
 * @param {T[]} list
 * @param {number} limit 并发上限（<=0 或非数字时按 1 处理）
 * @param {(item:T, index:number) => Promise<R>} fn
 * @returns {Promise<R[]>} 与 list 顺序一致的结果
 */
async function mapLimit(list, limit, fn) {
  const arr = Array.isArray(list) ? list : [];
  const out = new Array(arr.length);
  if (!arr.length) return out;

  const n = Math.max(1, Math.min(Math.floor(Number(limit) || 1), arr.length));
  /** 共享游标：worker 之间靠它领取下一个下标（JS 单线程，取号不会重复） */
  let next = 0;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= arr.length) return;
      out[i] = await fn(arr[i], i);
    }
  };

  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

module.exports = { mapLimit };
