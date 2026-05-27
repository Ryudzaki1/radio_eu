import io
import os
import tarfile
from pathlib import Path

import paramiko


ROOT = Path(__file__).resolve().parents[1]
MUSIC_DIR = ROOT / "music"
RU_HOST = os.environ["RU_HOST"]
RU_USER = os.environ.get("RU_USER", "radio")
RU_KEY = os.environ["RU_KEY"]
REMOTE_DIR = os.environ.get("REMOTE_DIR", "/opt/radio_ru")


def load_key(path):
    for key_cls in (paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey):
        try:
            return key_cls.from_private_key_file(path)
        except paramiko.SSHException:
            continue
    raise RuntimeError("Could not read SSH key")


def build_music_archive():
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for path in MUSIC_DIR.rglob("*"):
            if path.is_file():
                tar.add(path, arcname=path.relative_to(ROOT).as_posix())
    buffer.seek(0)
    return buffer.getvalue()


def run(client, command, timeout=900):
    _, stdout, stderr = client.exec_command(command, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    if out:
        print(out.encode("ascii", errors="replace").decode("ascii"))
    if err:
        print(err.encode("ascii", errors="replace").decode("ascii"))
    if code:
        raise RuntimeError(f"command failed: {command}")


archive = build_music_archive()
print(f"ARCHIVE_BYTES={len(archive)}")

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(RU_HOST, username=RU_USER, pkey=load_key(RU_KEY), look_for_keys=False, allow_agent=False)

try:
    remote_archive = "/tmp/radio-music.tar.gz"
    sftp = client.open_sftp()
    with sftp.file(remote_archive, "wb") as fh:
        fh.write(archive)
    sftp.close()

    script = f"""
set -euo pipefail
cd {REMOTE_DIR}
rm -rf music
mkdir -p music
tar -xzf {remote_archive} -C {REMOTE_DIR}
chown -R {RU_USER}:{RU_USER} {REMOTE_DIR}/music
rm -f {remote_archive}
docker compose restart radio
sleep 5
docker ps --format 'table {{{{.Names}}}}\\t{{{{.Status}}}}\\t{{{{.Ports}}}}'
curl -sS --max-time 20 http://127.0.0.1/api/tracks
"""
    run(client, "sudo -n bash -s <<'REMOTE_SCRIPT'\n" + script + "\nREMOTE_SCRIPT", timeout=900)
finally:
    client.close()
