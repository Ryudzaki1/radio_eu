import os
from pathlib import Path

import paramiko


host = os.environ["VPS_HOST"]
user = os.environ.get("VPS_USER", "root")
password = os.environ["VPS_PASS"]
remote_path = os.environ["REMOTE_PATH"]
local_path = Path(os.environ["LOCAL_PATH"])

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(
    host,
    username=user,
    password=password,
    look_for_keys=False,
    allow_agent=False,
)

try:
    sftp = client.open_sftp()
    with sftp.file(remote_path, "rb") as remote_file:
        data = remote_file.read()
    sftp.close()
finally:
    client.close()

local_path.parent.mkdir(parents=True, exist_ok=True)
local_path.write_bytes(data)
print(str(local_path.resolve()))
