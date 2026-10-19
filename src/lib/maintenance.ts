/**
 * 写路径上的维护触发器：hit() 只记账，到阈值就在后台跑，请求线程不再等待清理。
 * 单实例内存态；进程回收即丢，与 history 档位同为「本实例」语义。
 */
export interface Maintenance {
  /** 记一次写；到阈值就在后台跑，不返回 Promise，因此不会拖慢响应。 */
  hit(now?: number): void;
  /** 测试与优雅停机用：等待当前触发及其补偿触发全部完成。 */
  flush(): Promise<void>;
}

export function createMaintenance(o: {
  every: number;
  run: (now: number) => Promise<void>;
  onError?: (err: unknown) => void;
}): Maintenance {
  let writes = 0;
  // 已完成触发所对应的写入计数：用差值与阈值比较，天然把多次写入合并成一轮。
  let done = 0;
  let pending: Promise<void> | null = null;

  const maybeRun = (now: number): void => {
    if (pending || writes - done < o.every) return;
    done = writes;
    pending = o
      .run(now)
      .catch((err) => o.onError?.(err))
      .finally(() => {
        pending = null;
        // 运行期间又攒够一轮：补偿触发，否则高流量下维护会被永久饿死。
        if (writes - done >= o.every) maybeRun(Date.now());
      });
  };

  return {
    hit(now = Date.now()) {
      writes += 1;
      maybeRun(now);
    },
    async flush() {
      // 补偿触发会在 finally 里接上新的 pending，所以必须循环等。
      while (pending) await pending;
    },
  };
}
