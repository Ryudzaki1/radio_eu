import os

import paramiko


HOST = os.environ["RU_HOST"]
USER = os.environ.get("RU_USER", "radio")
KEY_PATH = os.environ["RU_KEY"]
PUBLIC_URL = os.environ.get("PUBLIC_URL", "http://111.88.144.171")


def load_key(path):
    for key_cls in (paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey):
        try:
            return key_cls.from_private_key_file(path)
        except paramiko.SSHException:
            continue
    raise RuntimeError("Could not read SSH key")


script = f"""
set -euo pipefail
cd /opt/radio_ru
if grep -q '^PUBLIC_RADIO_URL=' .env; then
  sed -i 's#^PUBLIC_RADIO_URL=.*#PUBLIC_RADIO_URL={PUBLIC_URL}#' .env
else
  printf '\\nPUBLIC_RADIO_URL={PUBLIC_URL}\\n' >> .env
fi
docker compose up -d
docker compose restart ru
sleep 5
grep -E '^(PUBLIC_RADIO_URL|ELEVENLABS_BASE_URL|PORT)=' .env
docker ps --format 'table {{{{.Names}}}}\\t{{{{.Status}}}}\\t{{{{.Ports}}}}'
curl -sS --max-time 10 http://127.0.0.1/api/radio/state
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, pkey=load_key(KEY_PATH), look_for_keys=False, allow_agent=False)
try:
    stdin, stdout, stderr = client.exec_command("sudo -n bash -s", timeout=300)
    stdin.write(script)
    stdin.channel.shutdown_write()
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    print(out.encode("ascii", errors="replace").decode("ascii"))
    if err:
        print(err.encode("ascii", errors="replace").decode("ascii"))
    code = stdout.channel.recv_exit_status()
    if code:
        raise SystemExit(code)
finally:
    client.close()
