import os

import paramiko


RU_HOST = os.environ["RU_HOST"]
RU_USER = os.environ.get("RU_USER", "radio")
RU_KEY = os.environ["RU_KEY"]
EU_HOST = os.environ["EU_HOST"]
EU_USER = os.environ.get("EU_USER", "root")
EU_PASS = os.environ["EU_PASS"]

RU_REPO = os.environ.get("RU_REPO", "https://github.com/Ryudzaki1/radio_ru.git")
EU_REPO = os.environ.get("EU_REPO", "https://github.com/Ryudzaki1/radio_eu.git")


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


def run_script(client, script, sudo=False, timeout=900):
    command = "sudo -n bash -s" if sudo else "bash -s"
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    stdin.write(script)
    stdin.channel.shutdown_write()
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    if out:
        print(out.encode("ascii", errors="replace").decode("ascii"))
    if err:
        print(err.encode("ascii", errors="replace").decode("ascii"))
    if code:
        raise RuntimeError(f"remote script failed with code {code}")


def setup_script(repo, path, owner=None):
    if owner:
        git = f"sudo -u {owner} GIT_SSH_COMMAND='ssh -i /home/{owner}/.ssh/github_deploy_ed25519 -o IdentitiesOnly=yes' git"
        prepare = f"""
mkdir -p /home/{owner}/.ssh
ssh-keyscan github.com >> /home/{owner}/.ssh/known_hosts 2>/dev/null || true
sort -u /home/{owner}/.ssh/known_hosts -o /home/{owner}/.ssh/known_hosts
chown -R {owner}:{owner} /home/{owner}/.ssh
mkdir -p {path}
chown -R {owner}:{owner} {path}
"""
        fix_owner = f"chown -R {owner}:{owner} {path}"
    else:
        git = "GIT_SSH_COMMAND='ssh -i /root/.ssh/github_deploy_ed25519 -o IdentitiesOnly=yes' git"
        prepare = """
mkdir -p /root/.ssh
ssh-keyscan github.com >> /root/.ssh/known_hosts 2>/dev/null || true
sort -u /root/.ssh/known_hosts -o /root/.ssh/known_hosts
"""
        fix_owner = "true"
    return f"""
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y git
{prepare}
if [ -d {path}/.git ]; then
  {git} -C {path} remote set-url origin {repo}
  {git} -C {path} fetch origin main
  {git} -C {path} reset --hard origin/main
else
  rm -rf {path}
  mkdir -p {path}
  {fix_owner}
  {git} clone {repo} {path}
fi
git config --global --add safe.directory {path} || true
{fix_owner}
echo "---RESULT---"
hostname
git -C {path} remote -v
git -C {path} rev-parse --abbrev-ref HEAD
git -C {path} rev-parse --short HEAD
"""


ru = connect_key(RU_HOST, RU_USER, RU_KEY)
eu = connect_password(EU_HOST, EU_USER, EU_PASS)

try:
    print("=== RU / Yandex ===")
    run_script(ru, setup_script(RU_REPO, "/opt/radio_ru", RU_USER), sudo=True, timeout=900)
    print("=== EU / Germany ===")
    run_script(eu, setup_script(EU_REPO, "/opt/radio_europa"), sudo=False, timeout=900)
finally:
    ru.close()
    eu.close()
