const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

async function captureModal() {
  const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--headless=new',
    '--remote-debugging-port=9223',
    '--hide-scrollbars',
    'file:///C:/Users/Acer/Downloads/assistente%20zap/public/cliente/painel.html#appointments'
  ]);

  await new Promise(r => setTimeout(r, 2000));

  try {
    const list = await new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:9223/json/list', res => {
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

    await sendCmd('Emulation.setDeviceMetricsOverride', {
      width: 1024,
      height: 768,
      deviceScaleFactor: 1,
      mobile: false
    });
    await new Promise(r => setTimeout(r, 500));

    // Open modal #modalNewAppointment
    await sendCmd('Runtime.evaluate', {
      expression: `(() => {
        const m = document.getElementById('modalNewAppointment');
        m.classList.remove('hidden');
        m.classList.add('flex');
        // also render calendar popover
        if (typeof renderBeautyCalendar === 'function') renderBeautyCalendar('apt');
        const popover = document.getElementById('aptBeautyCalendarPopover');
        if (popover) {
          popover.classList.remove('hidden');
          if (typeof positionAdaptiveDropdown === 'function') {
            positionAdaptiveDropdown(document.getElementById('aptDatePickerWrapper'), popover);
          }
        }
      })()`
    });
    await new Promise(r => setTimeout(r, 600));

    const shotModal = await sendCmd('Page.captureScreenshot', { format: 'png' });
    const bufModal = Buffer.from(shotModal.data, 'base64');
    fs.writeFileSync('public/images/beauty/jessica-beauty-modal-adaptive-1024x768.png', bufModal);
    fs.writeFileSync('C:/Users/Acer/.gemini/antigravity/brain/02a81ab1-3f50-4b80-b427-db4dc205d437/jessica-beauty-modal-adaptive-1024x768.png', bufModal);
    console.log('Modal screenshot captured! Size:', bufModal.length);

    chrome.kill();
  } catch (e) {
    console.error(e);
    chrome.kill();
  }
}

captureModal().then(() => process.exit(0));
