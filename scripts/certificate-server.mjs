import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

// Serve only the exported public root certificate. No directory is exposed.
const certificate = readFileSync(new URL('../certs/inside-local-ca.cer', import.meta.url));
const page = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>INSIDE · 安装体验证书</title>
<style>
body{margin:0;background:#f3f3ed;color:#262b25;font:16px/1.8 system-ui,-apple-system,sans-serif}
main{max-width:520px;margin:8vh auto;padding:28px}small{letter-spacing:2px;color:#66705c}
h1{font-size:28px;line-height:1.4}a{display:block;margin:24px 0;padding:13px 18px;border-radius:14px;background:#263426;color:white;text-align:center;text-decoration:none}
li{margin:16px 0}ol{padding-left:22px}.secondary{background:#dfe4d7;color:#263426}
</style>
<main>
<small>INSIDE / 本地体验</small>
<h1>让 iPhone 连接体感预览</h1>
<p>用 Safari 下载这台电脑的本地证书，然后在 iPhone 设置中安装并信任。</p>
<a href="/inside-local-ca.cer">下载本地证书</a>
<ol>
<li>打开「设置 → 通用 → VPN 与设备管理」，安装刚下载的证书描述文件。</li>
<li>进入「设置 → 通用 → 关于本机 → 证书信任设置」，为该 mkcert 根证书开启「完全信任」。</li>
<li>返回这里打开体验，点击「启用手机体感」并允许方向访问。</li>
</ol>
<a class="secondary" id="preview">已完成信任，打开体验</a>
<p>电脑服务需要保持运行，手机与电脑连接同一局域网。</p>
</main>
<script>
const preview = new URL(location.href);
preview.protocol = 'https:';
preview.port = '5188';
preview.pathname = '/';
preview.search = '';
preview.hash = '';
document.getElementById('preview').href = preview.href;
</script>
</html>`;

const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return;
  }
  const path = request.url?.split('?')[0];
  if (path === '/inside-local-ca.cer') {
    response.writeHead(200, {
      'Content-Type': 'application/x-x509-ca-cert',
      'Content-Length': certificate.length,
      'Content-Disposition': 'attachment; filename="inside-local-ca.cer"',
    });
    response.end(request.method === 'HEAD' ? undefined : certificate);
    return;
  }
  if (path === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : page);
    return;
  }
  response.writeHead(404);
  response.end();
});

server.on('error', error => {
  console.error(`Certificate download server: ${error.message}`);
  process.exitCode = 1;
});
server.listen(5189, '0.0.0.0', () => {
  console.log('iPhone certificate setup: http://localhost:5189/ (use the computer LAN IP on iPhone)');
});
