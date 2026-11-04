const fs = require('fs');
const vm = require('vm');

const files = [
  'public/admin.html',
  'public/cliente/login.html',
  'public/cliente/painel.html'
];

let totalScripts = 0;
for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let idx = 0;
  while ((match = re.exec(html)) !== null) {
    idx++;
    const code = match[1].trim();
    if (code) {
      totalScripts++;
      try {
        new vm.Script(code);
        console.log(`[PASS] ${file} script #${idx} (${code.length} chars) parsed successfully.`);
      } catch (err) {
        console.error(`[FAIL] ${file} script #${idx} failed syntax check:`, err.message);
        process.exit(1);
      }
    }
  }
}

console.log(`\nAll ${totalScripts} inline HTML scripts validated without any syntax error!`);
