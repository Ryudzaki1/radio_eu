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


def check(client, label, home, sudo_user=None):
    git_prefix = f"sudo -u {sudo_user} " if sudo_user else ""
    identity = f"{home}/.ssh/github_deploy_ed25519"
    script = f"""
set -e
echo "{label}_KEY"
cat {identity}.pub
echo "{label}_SSH_TEST"
{git_prefix}ssh -T -i {identity} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new git@github.com || true
echo "{label}_LS_REMOTE_RU"
{git_prefix}GIT_SSH_COMMAND='ssh -i {identity} -o IdentitiesOnly=yes' git ls-remote git@github.com:Ryudzaki1/radio_ru.git || true
echo "{label}_LS_REMOTE_EU"
{git_prefix}GIT_SSH_COMMAND='ssh -i {identity} -o IdentitiesOnly=yes' git ls-remote git@github.com:Ryudzaki1/radio_eu.git || true
"""
    stdin, stdout, stderr = client.exec_command("sudo -n bash -s", timeout=120)
    stdin.write(script)
    stdin.channel.shutdown_write()
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    print(out.encode("ascii", errors="replace").decode("ascii"))
    if err:
        print(err.encode("ascii", errors="replace").decode("ascii"))


ru = connect_key(RU_HOST, RU_USER, RU_KEY)
eu = connect_password(EU_HOST, EU_USER, EU_PASS)

try:
    check(ru, "RU", f"/home/{RU_USER}", sudo_user=RU_USER)
    check(eu, "EU", "/root")
finally:
    ru.close()
    eu.close()
