# RAIA AGENTES — RUNBOOK OPERACIONAL T9
## Criptografia em Repouso de Credenciais WhatsApp (Envelope KMS + AES-256-GCM)

**Documento:** Runbook Operacional e Guia de Configuração T9  
**Classificação:** Segurança Crítica (P0)  
**Conformidade:** OWASP ASVS 5.0 (Nível 3) · Matriz RAIA-27 (Proteção 09 / Risco R9)  
**Branch:** `security/raia-27-protecoes`  
**Região AWS Obrigatória:** `sa-east-1` (São Paulo)  

---

## 1. Visão Geral da Arquitetura

O módulo T9 elimina o risco de exposição de credenciais e chaves criptográficas do Baileys (`creds.json`, `pre-key-*.json`, `session-*.json`, etc.) através do padrão de **Criptografia por Envelope (Envelope Encryption)** gerenciada por chave mestra na **AWS KMS (Key Management Service)** na região `sa-east-1`.

```
                    ┌──────────────────────────┐
                    │   AWS KMS (sa-east-1)    │
                    │  Chave Mestra CMK (KMS)  │
                    └─────────────┬────────────┘
                                  │ GenerateDataKey / Decrypt
                                  ▼
      ┌────────────────────────────────────────────────────────┐
      │ Servidor RAIA AGENTES (Memória Volátil - RAM)          │
      │ • DEK Plaintext (32 bytes) em cache efêmero por tenant │
      │ • Zeroização forçada dek.fill(0) ao desconectar        │
      └──────────────┬───────────────────────────┬─────────────┘
                     │                           │
                     ▼                           ▼
      ┌──────────────────────────────┐ ┌──────────────────────────────┐
      │   Arquivo no Filesystem      │ │   Arquivos de Sessão (.enc)  │
      │       dek.wrapped            │ │   AES-256-GCM com AAD rígido │
      │  (DEK cifrada pela CMK KMS)  │ │   `wa:${tenantId}:${file}`   │
      └──────────────────────────────┘ └──────────────────────────────┘
```

### Propriedades de Segurança:
1. **Envelope Encryption:** A chave mestra CMK nunca sai da AWS. O KMS gera uma Chave de Criptografia de Dados (DEK) de 256 bits, entregando-a cifrada (`dek.wrapped`) para gravação em disco e em texto claro apenas na memória RAM da aplicação.
2. **Cifragem Autenticada AES-256-GCM:** Cada arquivo gravado pelo Baileys é cifrado com IV randômico de 12 bytes e tag de autenticação GCM de 16 bytes.
3. **Additional Authenticated Data (AAD) Vinculado:** O cabeçalho GCM autentica rigidamente o inquilino e o nome do arquivo (`wa:${tenantId}:${fileName}`). Uma chave transferida de um tenant para outro ou arquivo renomeado é sumariamente rejeitado (`AUTH_TAG_VERIFICATION_FAILED`).
4. **Isolamento de Memória:** O buffer da DEK é zerado em memória (`dek.fill(0)`) na desconexão da sessão (`disconnect()`) ou logout.

---

## 2. Configuração na AWS (Instruções Obrigatórias)

### 2.1 Criar a Chave Mestra (KMS CMK)
1. Acesse o **AWS Management Console** obrigatoriamente na região `sa-east-1` (São Paulo).
2. Navegue até **Key Management Service (KMS)** > **Customer managed keys** > **Create key**.
3. Selecione:
   - **Key type:** `Symmetric`
   - **Key usage:** `Encrypt and decrypt`
   - **Key material origin:** `KMS`
4. Nome/Alias: `alias/raia-agentes-whatsapp-sessions`.
5. Descrição: `Chave CMK para envelope encryption de credenciais Baileys - RAIA AGENTES (sa-east-1)`.
6. Habilite **Automatic Key Rotation** (rotação anual da chave pela AWS sem afetar decifração).

### 2.2 Política de IAM Obrigatória (Menor Privilégio com Restrição de IP e Contexto)
Crie um usuário IAM específico para o Easypanel (ex: `raia-kms-app-user`) ou configure uma IAM Policy anexada com a política JSON estrita abaixo.

> [!IMPORTANT]
> A restrição por IP via `aws:SourceIp` com o IP estático da VPS onde roda o Easypanel e a validação do Encryption Context (`purpose = wa-session`) são **obrigatórias**, impedindo o uso indevido da chave fora do servidor autorizado.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowRaiaSessionEnvelopeOperationsStrict",
      "Effect": "Allow",
      "Action": [
        "kms:GenerateDataKey",
        "kms:Decrypt"
      ],
      "Resource": "arn:aws:kms:sa-east-1:SUA_CONTA_AWS:key/SEU_KMS_KEY_ID",
      "Condition": {
        "StringEquals": {
          "kms:EncryptionContext:purpose": "wa-session"
        },
        "IpAddress": {
          "aws:SourceIp": "IP_ESTATICO_DA_VPS_EASYPANEL/32"
        }
      }
    }
  ]
}
```

---

## 3. Variáveis de Ambiente no Easypanel

Configure as seguintes variáveis no painel do **Easypanel** no serviço `raia-agentes`:

| Variável | Valor Recomendado | Descrição |
|---|---|---|
| `WA_CREDS_ENCRYPTION` | `off` (inicial) / `on` (pós-migração) | Ativa o armazenamento e leitura cifrada de credenciais WhatsApp. |
| `AWS_REGION` | `sa-east-1` | Região AWS da chave KMS (estritamente São Paulo). |
| `WA_KMS_KEY_ID` | `arn:aws:kms:sa-east-1:...` ou Alias | ARN ou Alias da chave CMK criada no KMS. |
| `AWS_ACCESS_KEY_ID` | `AKIA...` | Access Key ID do usuário IAM autorizado. |
| `AWS_SECRET_ACCESS_KEY` | `wJalr...` | Secret Access Key da aplicação. |
| `WA_SESSIONS_DISABLED` | `true` (apenas em manutenção) | Desativa o motor de WhatsApp para manutenção e migração segura. |

---

## 4. Procedimento de Migração e Homologação Operacional

Para evitar conflito de processos sem derrubar o container do Easypanel, a migração utiliza o modo de manutenção `WA_SESSIONS_DISABLED=true`. Nesse modo, o servidor web sobe sem ativar os sockets WhatsApp e sem criar a trava `data/wa-sessions.lock`.

> [!WARNING]
> É estritamente proibido criar cópias manuais em texto claro (`cp -r data/sessions ...`). A ferramenta `waCredsMigrate.js` move os arquivos para quarentena isolada (`data/sessions_quarantine/`) com integridade verificada byte-a-byte.

### 4.1 Roteiro de Homologação (Restrito Exclusivamente ao `--tenant 13`)
Em homologação/staging, a migração **NÃO** deve usar `--all`. Aplique apenas para o tenant de testes:

> [!NOTE]
> A ferramenta de migração `waCredsMigrate.js` deve ser executada obrigatoriamente **no mesmo container** da aplicação (acessado pelo console do Easypanel ou `docker exec`), para que a inspeção da trava `data/wa-sessions.lock` e a verificação do PID compartilhem o mesmo espaço de processos (PID namespace).

1. **Ativar Modo de Manutenção:**
   No Easypanel, defina `WA_SESSIONS_DISABLED=true` e reinicie a aplicação.
   O servidor web subirá sem acionar o motor de sessões do WhatsApp e sem criar a trava `data/wa-sessions.lock`.

2. **Acessar o Terminal do Container:**
   Pelo console do Easypanel ou SSH, execute a simulação:
   ```bash
   node scripts/waCredsMigrate.js --tenant 13 --dry-run
   ```
   *(Verifique se os arquivos e tamanhos estão corretos sem hashes expostos).*

3. **Executar a Migração com Quarentena:**
   ```bash
   node scripts/waCredsMigrate.js --tenant 13 --migrate
   ```
   O script gerará a DEK com KMS (`sa-east-1`), cifrará os arquivos com `fsync`, validará byte-a-byte e moverá o texto claro para `data/sessions_quarantine/`.

4. **Validar a Integridade:**
   ```bash
   node scripts/waCredsMigrate.js --tenant 13 --verify
   ```

5. **Reativar o Motor WhatsApp com Criptografia Ativa:**
   No Easypanel, configure:
   - `WA_SESSIONS_DISABLED=false`
   - `WA_CREDS_ENCRYPTION=on`
   Reinicie a aplicação.

6. **Confirmar Conexão:**
   Acesse `/api/salon/whatsapp/diagnostics` para o tenant 13 e confira se a sessão foi restaurada com sucesso.

---

## 5. Procedimento de Rollback de Contingência

Caso seja necessária a reversão imediata das credenciais cifradas para o formato legado em texto claro:

1. Defina `WA_SESSIONS_DISABLED=true` e reinicie.
2. Execute o rollback no container:
   ```bash
   node scripts/waCredsMigrate.js --tenant 13 --rollback --confirm-rollback
   ```
3. Defina `WA_CREDS_ENCRYPTION=off` e `WA_SESSIONS_DISABLED=false`.
4. Reinicie a aplicação.

---

## 6. Runbook de Diagnóstico e Recuperação de Falhas

### 6.1 `KMS_UNAVAILABLE` (KMS Temporariamente Indisponível ou Falha de Rede)
- **Sintoma:** O endpoint `/diagnostics` reporta `kmsStatus: 'unavailable'`, `kmsAttempts` e `kmsNextRetryAt`. O salão permanece com status `KMS_UNAVAILABLE` no banco de dados.
- **Comportamento do Sistema:** O sistema **NÃO** apaga credenciais, **NÃO** remove sessões e **NÃO** tenta parear novamente. Um agendador automático em background tenta restabelecer contato com o KMS em 5s, 15s, 60s e depois a cada 5 minutos.
- **Ação:** Verificar conectividade de rede da VPS com a AWS na região `sa-east-1` e permissões IAM. Assim que o KMS voltar, os salões serão restaurados automaticamente sem intervenção humana.
- **O QUE NUNCA FAZER:** **NÃO** reiniciar pareamento por QR/código. Não apagar arquivos de sessão.

### 6.2 `NOT_MIGRATED` (Credenciais em Texto Claro com Modo Cifrado Ativo)
- **Sintoma:** O salão tem arquivos `.json` legados mas não possui `.enc`.
- **Ação:** Ativar o modo de manutenção `WA_SESSIONS_DISABLED=true` e executar `node scripts/waCredsMigrate.js --tenant <id> --migrate`. Ao reiniciar a aplicação, a restauração detectará os arquivos `.enc` e subirá normalmente.
- **O QUE NUNCA FAZER:** **NÃO** gerar novo pareamento sobre a pasta existente.

### 6.3 `ENCRYPTED_FILE_CORRUPT` (Arquivo Cifrado Adulterado ou Corrompido)
- **Sintoma:** Erro de integridade de autenticação AES-256-GCM.
- **Comportamento do Sistema:**
  - Se for arquivo secundário (pre-key, session): o sistema renomeia o arquivo para `<arquivo>.enc.corrupt-<timestamp>` e ignora de forma segura sem derrubar a aplicação.
  - Se for `creds.json.enc` ou `dek.wrapped`: o sistema bloqueia o salão marcando status `ERROR` com `last_error = 'ENCRYPTED_FILE_CORRUPT'`.
- **Ação:** Notificar imediatamente o coordenador/Thiago. Se existir quarentena válida em `data/sessions_quarantine/`, analisar com o Revisor Técnico antes de qualquer restabelecimento.
- **O QUE NUNCA FAZER:** **NÃO** gerar novas credenciais por cima nem tentar forçar pareamento sem autorização formal.
