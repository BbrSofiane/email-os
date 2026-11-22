#!/usr/bin/env bash
set -euo pipefail
apk=${1:?APK path required}
expected_version=${2:?version name required}
expected_code=${3:?version code required}
expected_cert=${4:?SHA-256 certificate digest required}
build_tools="${ANDROID_HOME:?}/build-tools/35.0.0"
badging=$("$build_tools/aapt" dump badging "$apk")
grep -F "package: name='dev.exedev.emailos' versionCode='$expected_code' versionName='$expected_version'" <<< "$badging"
abis=$(sed -n "s/^native-code: //p" <<< "$badging")
[[ "$abis" == "'arm64-v8a' 'x86_64'" || "$abis" == "'x86_64' 'arm64-v8a'" ]]
certs=$("$build_tools/apksigner" verify --verbose --print-certs "$apk")
actual=$(sed -n 's/^Signer #1 certificate SHA-256 digest: //p' <<< "$certs" | tr '[:lower:]' '[:upper:]')
expected=$(tr -d ':' <<< "$expected_cert" | tr '[:lower:]' '[:upper:]')
[[ "$actual" == "$expected" && $(grep -c '^Signer #[0-9]* certificate SHA-256 digest:' <<< "$certs") == 1 ]]
"$build_tools/zipalign" -c -P 16 4 "$apk"
python3 - "$apk" "${ANDROID_HOME}/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf" <<'PY'
import subprocess, sys, tempfile, zipfile
with zipfile.ZipFile(sys.argv[1]) as apk:
    libs = [n for n in apk.namelist() if n.startswith('lib/') and n.endswith('.so')]
    if not libs:
        raise SystemExit('No native libraries')
    for name in libs:
        with tempfile.TemporaryFile() as f:
            f.write(apk.read(name)); f.flush()
            result = subprocess.check_output([sys.argv[2], '-lW', f'/proc/{__import__("os").getpid()}/fd/{f.fileno()}'], text=True)
        for line in result.splitlines():
            fields = line.split()
            if fields and fields[0] == 'LOAD' and int(fields[-1], 16) < 16384:
                raise SystemExit(f'{name}: unaligned LOAD segment')
print('APK metadata, signer, ABIs and alignment verified')
PY
