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
        {meta.version ? <span>v{meta.version}</span> : null}
        <span>每 {meta.intervalSeconds}s 探测</span>
        <span>保留 {meta.historyDays} 天</span>
        <span>时区 {site.timezone}</span>
      </div>
      <p className="footer-note">
        {meta.publicView ? (
          <>公网视图：探测目标与错误详情已隐藏，数据只保存在本机，不上传任何第三方。</>
        ) : (
          <>
            所有探测数据只保存在本机 <code>{meta.configFile}</code> 同级的 <code>data/</code> 目录，不上传任何第三方。
          </>
        )}
      </p>
    </footer>
  );
}
