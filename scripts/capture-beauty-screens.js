const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

async function capture() {
  const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--headless=new',
    '--remote-debugging-port=9222',
    '--hide-scrollbars',
    'file:///C:/Users/Acer/Downloads/assistente%20zap/public/cliente/painel.html#appointments'
  ]);

  await new Promise(r => setTimeout(r, 2000));

  try {
    const list = await new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:9222/json/list', res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });
    const page = list.find(p => p.url.includes('painel.html'));
    if (!page) {
      console.log('painel page not found');
      chrome.kill();
      return;
    }

    const ws = new WebSocket(page.webSocketDebuggerUrl);

    function sendCmd(method, params = {}) {
      return new Promise((resolve) => {
        const id = Math.floor(Math.random() * 100000);
        function handler(msg) {
          const res = JSON.parse(msg.data);
          if (res.id === id) {
            ws.removeEventListener('message', handler);
            resolve(res.result);
          }
        }
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await new Promise(r => ws.onopen = r);

    // 1. Desktop 1024x768
    await sendCmd('Emulation.setDeviceMetricsOverride', {
      width: 1024,
      height: 768,
      deviceScaleFactor: 1,
      mobile: false
    });
    await new Promise(r => setTimeout(r, 600));
    const shotDesktop = await sendCmd('Page.captureScreenshot', { format: 'png' });
    const bufDesktop = Buffer.from(shotDesktop.data, 'base64');
    fs.writeFileSync('public/images/beauty/jessica-beauty-desktop-1024x768.png', bufDesktop);
    fs.writeFileSync('C:/Users/Acer/.gemini/antigravity/brain/02a81ab1-3f50-4b80-b427-db4dc205d437/jessica-beauty-desktop-1024x768.png', bufDesktop);
    console.log('Desktop 1024x768 captured! Size:', bufDesktop.length);

    // 2. Mobile 390x844
    await sendCmd('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true
    });
    await new Promise(r => setTimeout(r, 600));
    const shotMobile = await sendCmd('Page.captureScreenshot', { format: 'png' });
    const bufMobile = Buffer.from(shotMobile.data, 'base64');
    fs.writeFileSync('public/images/beauty/jessica-beauty-mobile-390x844.png', bufMobile);
    fs.writeFileSync('C:/Users/Acer/.gemini/antigravity/brain/02a81ab1-3f50-4b80-b427-db4dc205d437/jessica-beauty-mobile-390x844.png', bufMobile);
    console.log('Mobile 390x844 captured! Size:', bufMobile.length);

    // 3. Mobile with Sidebar Drawer Opened
    await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const sb = document.getElementById('sidebar');
        sb.classList.remove('-translate-x-full');
      })()`
    });
    await new Promise(r => setTimeout(r, 400));
    const shotDrawer = await sendCmd('Page.captureScreenshot', { format: 'png' });
    const bufDrawer = Buffer.from(shotDrawer.data, 'base64');
    fs.writeFileSync('public/images/beauty/jessica-beauty-mobile-drawer-390x844.png', bufDrawer);
    fs.writeFileSync('C:/Users/Acer/.gemini/antigravity/brain/02a81ab1-3f50-4b80-b427-db4dc205d437/jessica-beauty-mobile-drawer-390x844.png', bufDrawer);
    console.log('Mobile Drawer 390x844 captured! Size:', bufDrawer.length);

    chrome.kill();
  } catch (e) {
    console.error(e);
    chrome.kill();
  }
}

capture().then(() => process.exit(0));
