import type { State } from "../state.ts";
import { timeText } from "./time.ts";

const CONNECTION: Record<State["connection"], string> = {
  connecting: "連線中",
  open: "已連上",
  offline: "連線中斷，正在重新連線",
  auth_expired: "登入已過期，請重新整理",
  keys_unavailable: "本機端暫時無法驗證登入，稍後自動重試",
};

const usd = (n: number) => `$${n.toFixed(2)}`;

export function StatusBar({ state }: { state: State }) {
  const { relay, status } = state;
  return (
    <header className="status">
      <p>{CONNECTION[state.connection]}</p>
      <p>
        {relay.online ? "本機端在線" : "本機端離線"}
        {!relay.online && relay.lastSeenAt !== undefined
          ? `（最後在線 ${timeText(relay.lastSeenAt)}）`
          : ""}
      </p>
      {state.localSince === undefined ? null : (
        <p>本機端這一次連上：{timeText(state.localSince)}</p>
      )}
      {state.reconnectedAt === undefined ? null : (
        <p className="warning" role="alert">
          本機端在 {timeText(state.reconnectedAt)} 重新連上。如果不是你重啟的，請到 Cloudflare
          檢查憑證
        </p>
      )}
      {status === undefined ? null : (
        <ul className="spend">
          {status.providers.map((p) => (
            <li key={p.name}>
              {p.name}：{usd(p.spentUsd)} / {usd(p.quotaUsd)}（警示 {usd(p.warnUsd)}，停止{" "}
              {usd(p.stopUsd)}）{p.stopped ? "已停止" : ""}
            </li>
          ))}
        </ul>
      )}
      {status === undefined ? null : (
        <p>
          通知：{status.notify === "ok" ? "已設定" : "未設定"}
          {status.pricesWarn ? "；價格表過期，請在終端更新" : ""}
        </p>
      )}
    </header>
  );
}
