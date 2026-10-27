import requests
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

base_url = 'https://n8n-n8n.cla6w1.easypanel.host/api/v1'
api_key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIyMTM3YzQ1Ny1jYzc3LTRhYmItYTA3Ni01MzdlNmFjYjcxYjUiLCJpc3MiOiJuOG4iLCJqdGkiOiJhY2QwZTRiMS0xODBjLTQ4MmMtODYzZC0xYWQ2MjY5ODkyZmYiLCJpYXQiOjE3OTMxMDM1OTgsImF1ZCI6InB1YmxpYy1hcGkifQ.ew_3OOgFRbTPVFTqjV9AvFFoh2hf5SBcdgxhFSdjDlE'
headers = {
    'X-N8N-API-KEY': api_key,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
}

wf_id = 'hlZlVOLTyCeYIKNs'

res = requests.get(f'{base_url}/workflows/{wf_id}', headers=headers, timeout=10)
wf = res.json()

for n in wf['nodes']:
    if 'toolCode' in n.get('type', ''):
        # In n8n toolCode, let's see what happens if pythonCode and jsCode are both present or if language is python vs javascript
        n['parameters']['pythonCode'] = 'return "{}"'
        n['parameters']['jsCode'] = 'return JSON.stringify({ status: "ok" });'

payload = {
    'name': wf['name'],
    'nodes': wf['nodes'],
    'connections': wf['connections'],
    'settings': wf.get('settings', {})
}

update_res = requests.put(f'{base_url}/workflows/{wf_id}', headers=headers, json=payload, timeout=10)
print('Updated with both codes:', update_res.status_code)
