"""Drive one explicitly confirmed fixture command through a real terminal."""
import errno
import os
import pty
import sys

pid, master = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)

pending = memoryview(sys.stdin.buffer.read())
while pending:
    pending = pending[os.write(master, pending):]
try:
    while True:
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not data:
            break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
finally:
    os.close(master)
_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
sys.exit(code if code >= 0 else 128 - code)
