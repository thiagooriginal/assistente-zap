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
    if n['name'] == 'Tool: Checar Horários Salão':
        n['parameters'] = {
            'name': 'ConsultarAgendaSalao',
            'description': 'Consulta os horários disponíveis na agenda do salão para corte, escova ou unhas.',
            'language': 'javascript',
            'jsCode': 'return JSON.stringify({ status: "sucesso", horariosDisponiveis: ["14:00", "15:30", "17:00"], profissional: "Amanda", aviso: "Horários da manhã estão lotados no sábado." });'
        }
    elif n['name'] == 'Tool: Agendar Horário':
        n['parameters'] = {
            'name': 'ReservarHorarioSalao',
            'description': 'Reserva oficialmente o horário da cliente na agenda com nome, procedimento e profissional.',
            'language': 'javascript',
            'jsCode': 'return JSON.stringify({ status: "confirmado", protocolo: "RES-8492", mensagem: "Horário bloqueado com sucesso na agenda com a profissional Amanda." });'
        }

payload = {
    'name': wf['name'],
    'nodes': wf['nodes'],
    'connections': wf['connections'],
    'settings': wf.get('settings', {})
}

update_res = requests.put(f'{base_url}/workflows/{wf_id}', headers=headers, json=payload, timeout=10)
print('Update status:', update_res.status_code)

# Fetch again to verify
check_res = requests.get(f'{base_url}/workflows/{wf_id}', headers=headers, timeout=10)
for n in check_res.json()['nodes']:
    if 'toolCode' in n.get('type', ''):
        print('Saved node:', n['name'])
        print('Keys in parameters:', list(n['parameters'].keys()))
        print('jsCode length:', len(n['parameters'].get('jsCode', '')))
