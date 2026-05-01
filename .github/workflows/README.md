# GitHub Actions Workflows

## backup-supabase.yml

Backup giornaliero automatico del database Supabase.

### Cosa fa
- **Schedule**: ogni giorno alle 04:00 UTC (06:00 IT)
- **Trigger manuale**: tab Actions → "Backup Supabase Database" → Run workflow
- **Output**: dump cifrato GPG con passphrase, salvato come artifact GitHub (retention 90 giorni)

### Setup richiesto (1 sola volta)

Su https://github.com/Rafflentini/cervellone/settings/secrets/actions aggiungere:

1. **`SUPABASE_DB_URL`** — connection string Postgres diretta del database Supabase
   - Dashboard Supabase → Settings → Database → "Connection string" → URI
   - Importante: usare la connection diretta (porta 5432), non il pooler transactional (porta 6543)
   - Formato: `postgresql://postgres.PROJECT_REF:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres`

2. **`BACKUP_GPG_PASSPHRASE`** — passphrase random forte (≥32 caratteri) per la cifratura GPG
   - Genera con: `openssl rand -base64 32` o usa un password manager
   - **Salva in luogo sicuro**: senza questa NON puoi recuperare i backup

### Recovery (in caso di disastro)

```bash
# 1. Scarica l'artifact dal tab Actions di GitHub
# 2. Decifra
gpg --decrypt cervellone-YYYYMMDD-HHMMSS.sql.gz.gpg > cervellone.sql.gz
# 3. Decomprimi
gunzip cervellone.sql.gz
# 4. Restore (su DB nuovo o di staging)
psql "$NEW_DB_URL" < cervellone.sql
```

### Costi
Zero. GitHub Actions free tier: 2000 minuti/mese (bastano centinaia di run). Storage artifact 90 giorni gratis.

### Quando passare a Backblaze B2 / S3
- Quando i dump superano i ~500MB (l'artifact GitHub ha cap 2GB ma diventa lento)
- Quando vuoi retention >90 giorni
- Quando vuoi backup in altra regione geografica
