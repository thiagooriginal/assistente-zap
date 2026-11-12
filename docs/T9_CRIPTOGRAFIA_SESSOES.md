# RAIA AGENTES — RUNBOOK OPERACIONAL T9
## Criptografia em Repouso de Credenciais WhatsApp (Envelope KMS + AES-256-GCM)

**Documento:** Runbook Operacional e Guia de Configuração T9  
**Classificação:** Segurança Crítica (P0)  
**Conformidade:** OWASP ASVS 5.0 (Nível 3) · Matriz RAIA-27 (Proteção 09 / Risco R9)  
**Branch:** `security/raia-27-protecoes`

---

## 1. Visão Geral da Arquitetura

O módulo T9 elimina o risco de exposição de credenciais e chaves criptográficas do Baileys (`creds.json`, `pre-key-*.json`, `session-*.json`, etc.) através do padrão de **Criptografia por Envelope (Envelope Encryption)** gerenciada por chave mestra na **AWS KMS (Key Management Service)**.

```
                    ┌──────────────────────────┐
                    │   AWS KMS (us-east-1)    │
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
4. **Isolamento de Memória:** O hash da DEK é zerado em memória (`dek.fill(0)`) na desconexão da sessão ou logout do assistente.

---

## 2. Configuração na AWS (Instruções para o Thiago)

### 2.1 Criar a Chave Mestra (KMS CMK)
1. Acesse o **AWS Management Console** na região escolhida (ex: `us-east-1`).
2. Navegue até **Key Management Service (KMS)** > **Customer managed keys** > **Create key**.
3. Selecione:
   - **Key type:** `Symmetric`
   - **Key usage:** `Encrypt and decrypt`
   - **Key material origin:** `KMS`
4. Nome/Alias: `raia-agentes-whatsapp-sessions`.
5. Descrição: `Chave CMK para envelope encryption de credenciais Baileys - RAIA AGENTES`.
6. Defina a política de exclusão com retenção mínima e habilite **Automatic Key Rotation** (rotação anual de chaves sem afetar decifração).

### 2.2 Política de IAM com Menor Privilégio
Crie um usuário IAM específico para o Easypanel (ex: `raia-kms-app-user`) ou configure uma IAM Role com a política estrita abaixo:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowRaiaSessionEnvelopeOperations",
      "Effect": "Allow",
      "Action": [
        "kms:GenerateDataKey",
        "kms:Decrypt"
      ],
      "Resource": "arn:aws:kms:us-east-1:SUA_CONTA_AWS:key/SEU_KMS_KEY_ID",
      "Condition": {
        "StringEquals": {
          "kms:EncryptionContext:purpose": "wa-session"
        }
      }
    }
  ]
}
```

> [!TIP]
> Caso o servidor de produção possua IP público fixo no Easypanel, adicione a restrição `aws:SourceIp` na condição da política para proteção de borda adicional contra vazamento acidental de credenciais de API.

---

## 3. Variáveis de Ambiente no Easypanel

Adicione as variáveis de ambiente abaixo no painel do **Easypanel** no serviço `raia-agentes`:

| Variável | Valor Recomendado | Descrição |
|---|---|---|
| `WA_CREDS_ENCRYPTION` | `on` | Ativa o armazenamento e a leitura cifrada de sessões. |
| `AWS_REGION` | `us-east-1` | Região AWS da chave KMS. |
| `AWS_KMS_KEY_ID` | `arn:aws:kms:...` ou Alias | ARN ou ID da chave CMK criada no KMS. |
| `AWS_ACCESS_KEY_ID` | `AKIA...` | Access Key ID do usuário IAM da aplicação. |
| `AWS_SECRET_ACCESS_KEY` | `wJalr...` | Secret Access Key da aplicação. |

---

## 4. Procedimento de Migração Operacional (Passo a Passo)

A migração de credenciais existentes para o formato cifrado deve ocorrer durante uma janela rápida de manutenção (1 a 3 minutos).

### Passo 1: Backup Preventivo
Faça o backup de segurança do SQLite e das sessões:
```bash
# Backup do banco operacional
cp data/assistant.db data/assistant_backup_t9.db

# Backup das sessões atuais
cp -r data/sessions data/sessions_backup_t9
```

### Passo 2: Parar a Aplicação
No Easypanel, pause ou pare temporariamente a aplicação. Isso evita leituras ou gravações concorrentes no Baileys. O utilitário `waCredsMigrate.js` verificará `data/app.lock` e recusará a migração se a aplicação ainda estiver rodando.

### Passo 3: Executar a Migração Cifrada
No terminal do servidor ou container:
```bash
# 1. Simulação prévia para auditoria (não altera arquivos)
node scripts/waCredsMigrate.js --all --dry-run

# 2. Executar a migração oficial
node scripts/waCredsMigrate.js --all --migrate

# 3. Validar a integridade de todas as credenciais migradas
node scripts/waCredsMigrate.js --all --verify
```

O script realizará:
- Validação do lock de processo.
- Geração da DEK via KMS e gravação de `dek.wrapped`.
- Cifragem AES-256-GCM de cada arquivo `.json` gerando `.enc` com `fsync`.
- Teste de sanidade obrigatório com comparação byte-a-byte.
- Quarentena segura dos arquivos em texto claro em `data/sessions_quarantine/` (nenhum arquivo é excluído).

### Passo 4: Ativar `WA_CREDS_ENCRYPTION=on` e Iniciar
1. No Easypanel, defina `WA_CREDS_ENCRYPTION=on`.
2. Inicie a aplicação.
3. Consulte o endpoint operacional de diagnóstico:
   `GET /api/salon/whatsapp/diagnostics` (requer autenticação de salão ou admin).
   Verifique se retorna:
   ```json
   {
     "encryptionMode": "on",
     "sessionEncrypted": true,
     "notMigrated": false,
     "kmsStatus": "healthy"
   }
   ```

---

## 5. Procedimento de Rollback de Contingência

Caso ocorra qualquer comportamento inesperado ou indisponibilidade imprevista, o rollback é 100% suportado:

1. **Parar a aplicação** no Easypanel.
2. **Executar o utilitário de reversão:**
   ```bash
   node scripts/waCredsMigrate.js --all --rollback --confirm-rollback
   ```
   *O utilitário decifra todos os arquivos `.enc` para o formato `.json` original em diretório temporário de staging, valida a integridade JSON e substitui os arquivos no disco.*
3. No Easypanel, defina `WA_CREDS_ENCRYPTION=off`.
4. Inicie a aplicação.

---

## 6. Planos de Contingência e Resiliência

### Indisponibilidade Temporária do AWS KMS
Se a conexão com o KMS falhar durante a reinicialização da aplicação:
- A rotina de restauração marca a sessão como `KMS_UNAVAILABLE`.
- As credenciais no banco SQLite **NÃO SÃO APAGADAS NEM RESETADAS**.
- Nenhuma desconexão destrutiva é realizada.
- Assim que o KMS ou a rede for restabelecida, o próximo ciclo de conexão restaura a sessão automaticamente.

### Política de Exclusão e Retenção no KMS
- **Nunca force a exclusão imediata da chave KMS.**
- Se a chave for excluída no KMS, as credenciais em disco tornam-se matematicamente indecifráveis.
- Utilize sempre um período de agendamento de exclusão (*Key Deletion Window*) de 30 dias na AWS.
