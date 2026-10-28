# bin/

Drop the xray-core executable here (`xray.exe` on Windows, `xray` elsewhere) to
let the bundle ship its own binary:

```
dsh-2xray/bin/xray.exe
```

Resolution order (see `lib/binary.js`):

1. `config.binary.path`
2. `DSH_XRAY_BIN`
3. **this directory**
4. `<dataDir>/bin/` (`%USERPROFILE%\.dsh\xray-proxy\bin`)
5. `PATH`

## Licensing

Xray-core is MPL-2.0. Redistributing the binary inside a plugin package is
allowed, but the MPL requires that the source of the covered files be made
available and that modifications stay under the MPL. If you vendor a binary,
record the exact version and its upstream release URL in this directory, and
keep the license notice. The plugin itself never downloads xray at runtime.

Binaries are intentionally git-ignored (`.gitignore`): commit the version
record, not a 15–30 MB blob.
