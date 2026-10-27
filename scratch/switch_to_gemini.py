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

# Replace OpenAI node with Google Gemini node
new_nodes = []
gemini_node_id = None
openai_old_name = None

for n in wf['nodes']:
    if 'openAi' in n.get('type', '') or 'OpenAI' in n.get('name', ''):
        openai_old_name = n['name']
        gemini_node = {
            'parameters': {
                'modelName': 'models/gemini-2.5-flash',
                'options': {}
            },
            'id': n['id'],
            'name': 'Google Gemini Chat Model',
            'type': '@n8n/n8n-nodes-langchain.lmChatGoogleGemini',
            'typeVersion': 1,
            'position': n['position'],
            'credentials': {
                'googlePalmApi': {
                    'id': 'elAZTspQT7Yvrg37',
                    'name': 'Google Gemini(PaLM) Api account ( PLANO ESTUDANTE)'
                }
            }
        }
        new_nodes.append(gemini_node)
        print('Replaced OpenAI node with Google Gemini Chat Model')
    else:
        new_nodes.append(n)

# Update connections
new_connections = {}
for src, t in wf['connections'].items():
    if src == openai_old_name:
        new_connections['Google Gemini Chat Model'] = t
    else:
        new_connections[src] = t

payload = {
    'name': wf['name'],
    'nodes': new_nodes,
    'connections': new_connections,
    'settings': wf.get('settings', {})
}

update_res = requests.put(f'{base_url}/workflows/{wf_id}', headers=headers, json=payload, timeout=10)
print('PUT status with Google Gemini:', update_res.status_code)
if update_res.status_code == 200:
    print('Google Gemini node installed successfully!')
