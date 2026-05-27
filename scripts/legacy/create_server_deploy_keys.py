import os

import paramiko


RU_HOST = os.environ["RU_HOST"]
RU_USER = os.environ.get("RU_USER", "radio")
RU_KEY = os.environ["RU_KEY"]
EU_HOST = os.environ["EU_HOST"]
EU_USER = os.environ.get("EU_USER", "root")
EU_PASS = os.environ["EU_PASS"]


def load_key(path):
    for key_cls in (paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey):
        try:
            return key_cls.from_private_key_file(path)
        except paramiko.SSHException:
            continue
    raise RuntimeError("Could not read SSH key")


def connect_key(host, user, key_path):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, pkey=load_key(key_path), look_for_keys=False, allow_agent=False)
    return client


def connect_password(host, user, password):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, look_for_keys=False, allow_agent=False)
    return client


def run(client, command, sudo=False):
    full = "sudo -n bash -s" if sudo else "bash -s"
    stdin, stdout, stderr = client.exec_command(full, timeout=120)
    stdin.write(command)
    stdin.channel.shutdown_write()
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    if err:
        print(err.encode("ascii", errors="replace").decode("ascii"))
    if code:
        raise RuntimeError(f"command failed: {command}")
    return out.strip()


def ensure_key(client, home, sudo=False):
    command = f"""
set -euo pipefail
mkdir -p {home}/.ssh
chmod 700 {home}/.ssh
if [ ! -f {home}/.ssh/github_deploy_ed25519 ]; then
  ssh-keygen -t ed25519 -N '' -f {home}/.ssh/github_deploy_ed25519 -C 'codex-deploy-key'
fi
cat > {home}/.ssh/config <<'EOF'
Host github.com
  HostName github.com
  User git
  IdentityFile {home}/.ssh/github_deploy_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
EOF
chmod 600 {home}/.ssh/config {home}/.ssh/github_deploy_ed25519
cat {home}/.ssh/github_deploy_ed25519.pub
"""
    return run(client, command, sudo=sudo)


ru = connect_key(RU_HOST, RU_USER, RU_KEY)
eu = connect_password(EU_HOST, EU_USER, EU_PASS)

try:
    print("RU_DEPLOY_KEY_BEGIN")
    print(ensure_key(ru, f"/home/{RU_USER}", sudo=False))
    print("RU_DEPLOY_KEY_END")
    print("EU_DEPLOY_KEY_BEGIN")
    print(ensure_key(eu, "/root", sudo=False))
    print("EU_DEPLOY_KEY_END")
finally:
    ru.close()
    eu.close()
