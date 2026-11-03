import type { StatusPayload } from "../types";

interface Props {
  meta: StatusPayload["meta"];
  site: StatusPayload["site"];
}

export function Footer({ meta, site }: Props) {
  return (
    <footer className="footer">
      <div className="footer-left">
        <span className="footer-brand">{site.name}</span>
        <span className="footer-dim">· 自托管状态页</span>
      </div>
      <div className="footer-meta">
        <span>v{meta.version}</span>
        <span>每 {meta.intervalSeconds}s 探测</span>
        <span>保留 {meta.historyDays} 天</span>
        <span>时区 {site.timezone}</span>
      </div>
      <p className="footer-note">
        所有探测数据只保存在本机 <code>{meta.configFile}</code> 同级的 <code>data/</code> 目录，不上传任何第三方。
      </p>
    </footer>
  );
}
