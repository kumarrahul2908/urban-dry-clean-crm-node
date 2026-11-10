# One-time setup: deploy from GitHub Actions instead of SSH-ing in yourself

This lets `.github/workflows/deploy.yml` push code and run `bootstrap-ubuntu.sh` on the VPS
without ever handing anyone (Claude included) your root password or your own personal SSH key.
It uses a **separate, deploy-only** key pair.

## 1. Generate a deploy-only key pair (on your own machine, not in chat)

```bash
ssh-keygen -t ed25519 -f udc_deploy -N '' -C "udc-deploy"
```

This makes two files: `udc_deploy` (private — keep this) and `udc_deploy.pub` (public).

## 2. Add the public half to the VPS

On the VPS (as root, over your existing terminal access):

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo 'PASTE_THE_CONTENTS_OF_udc_deploy.pub_HERE' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

This is appended, not replacing anything — your own key (and anyone else's already there) keeps
working exactly as before.

## 3. Add the private half as a GitHub secret

GitHub → this repo → **Settings → Secrets and variables → Actions → New repository secret**

- Name: `DEPLOY_SSH_KEY`
- Value: the full contents of `udc_deploy` (the private key file — starts with
  `-----BEGIN OPENSSH PRIVATE KEY-----`)

Delete `udc_deploy` / `udc_deploy.pub` from your machine once this is saved, if you like — GitHub
only needs its own copy.

## 4. Run it

GitHub → **Actions → Deploy to VPS → Run workflow**. Defaults are already set for
`bill.urbandryclean.in` / port 3100. Watch the run's logs for `>>> Up.` at the end, or for a line
telling you what still needs fixing (e.g. `Edit $APP/.env … then re-run`).

Re-running the same workflow later (e.g. after a code change) is safe — `bootstrap-ubuntu.sh` is
idempotent and never touches `/opt/udc/.env`, the uploaded files, or the database beyond running
migrations.

## What this still does NOT automate

- Filling in `/opt/udc/.env` the first time (`DB_*`, `APP_SECRET_KEY` — must be the **same** value
  the PHP app uses) — the workflow will stop and tell you to do this, then re-run.
- Importing the `crm.urbandryclean.in` database dump.
- The one-off counter fix on the live PHP database (not needed for Node — see `docs/PARITY.md`,
  "Counters are MAX(existing)+1").
