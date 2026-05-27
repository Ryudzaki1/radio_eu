import os

import paramiko


host = os.environ["VPS_HOST"]
user = os.environ.get("VPS_USER", "radio")
key_path = os.environ["VPS_KEY"]

key = None
for key_cls in (paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey):
    try:
        key = key_cls.from_private_key_file(key_path)
        break
    except paramiko.SSHException:
        continue
if key is None:
    raise RuntimeError("Could not read SSH key")

script = r"""
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y full-upgrade
apt-get -y autoremove
apt-get -y autoclean
echo "---STATUS---"
hostname
if command -v lsb_release >/dev/null 2>&1; then
  lsb_release -a
else
  cat /etc/os-release
fi
if [ -f /var/run/reboot-required ]; then
  echo REBOOT_REQUIRED
else
  echo NO_REBOOT_REQUIRED
fi
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, pkey=key, look_for_keys=False, allow_agent=False)

try:
    stdin, stdout, stderr = client.exec_command("sudo -n bash -s", timeout=1800)
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
