# Installing Silverdaw

Silverdaw is a Windows desktop application (Windows 10 version 1809 or later, or
Windows 11, 64-bit). There are three ways to install it. The **Microsoft Store**
is the easiest and recommended option once it is available.

| Option | Best for | Effort | Certificate? | Updates | Windows integration\* |
| ------ | -------- | ------ | ------------ | ------- | --------------------- |
| **Microsoft Store** *(coming soon)* | Everyone | One click | No | Automatic | Full |
| **Portable download** (zip) | Trying it quickly, no install | Unzip & run | No | Manual | None |
| **Self-signed installer** | A full install before the Store release | Trust a certificate + run a script | Yes | Manual | Full |

\* *Windows integration* = a Start-menu entry, the `.silverdaw` file association
(double-click a project to open it), and an entry in **Settings ▸ Apps** for a
clean uninstall.

---

## 1. Microsoft Store — recommended *(coming soon)*

Once published, Silverdaw will install in one click from the Microsoft Store.
Microsoft signs and distributes the package, so there are no certificates to
manage and no security prompts, and updates arrive automatically.

**Pros**

- Easiest install — one click, no setup.
- No certificates and no security warnings.
- Automatic updates.
- Clean install and uninstall managed by Windows.
- Full Windows integration (Start menu + file association).

**Cons**

- Not available yet — this option is coming soon.

*(A direct Store link will be added here when the app goes live.)*

---

## 2. Portable download (zip)

Download `Silverdaw-<version>.zip` from the [latest release][releases], extract it
to any folder you can write to, and run `Silverdaw.exe`. Nothing is installed.

**Pros**

- No installation, no administrator rights, no certificate.
- Runs from anywhere — a normal folder, an external drive, etc.
- Trivial to remove: just delete the extracted folder.

**Cons**

- The first launch may show a Windows SmartScreen prompt
  (*"Windows protected your PC"* → **More info** → **Run anyway**) because the
  file was downloaded from the internet.
- No Start-menu entry, no `.silverdaw` file association, and no
  **Settings ▸ Apps** uninstall entry.
- No automatic updates — re-download a newer zip to update.

**Steps**

1. Download `Silverdaw-<version>.zip` from the [latest release][releases].
2. *(Optional, avoids the SmartScreen prompt)* right-click the zip →
   **Properties** → tick **Unblock** → **OK**.
3. Extract it to a folder you can write to.
4. Run `Silverdaw.exe`.

---

## 3. Self-signed local installer (advanced)

The installable package is signed with a **self-signed** `CN=Silverdaw`
certificate. Before Windows will install it, that certificate has to be trusted
on your machine. A helper script does both steps (trust the certificate, then
install the app) for you.

Download these three files from the [latest release][releases] **into the same
folder**:

- `Silverdaw-<version>.appx` — the signed app package (this is the sideload
  package — **not** the `-store.appx`, which is unsigned and only for Microsoft
  Store submission)
- `Silverdaw-PublicCert.cer` — the public certificate
- `Install-Silverdaw.ps1` — the helper script

**Steps**

1. *(Recommended)* verify the certificate matches the release. In PowerShell:

   ```powershell
   Get-FileHash Silverdaw-PublicCert.cer -Algorithm SHA256
   ```

   Confirm the hash matches the **SHA-256 fingerprint** published in the release
   notes. (The script performs this check automatically and refuses to continue
   on a mismatch.)
2. Right-click `Install-Silverdaw.ps1` → **Run with PowerShell**, and approve the
   **User Account Control (UAC)** prompt (elevate with your own administrator
   account). If Windows blocks the script — for example *"running scripts is
   disabled on this system"* — run it from PowerShell with an explicit bypass,
   which reliably sidesteps the execution policy:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\Install-Silverdaw.ps1
   ```

   *(Right-click → **Properties** → **Unblock** only clears the "downloaded from
   the internet" mark; it does not change the execution policy, so the command
   above is the dependable fix if the script is still blocked.)*

The script verifies the certificate against the published fingerprint, imports
its **public** half into the machine's *Trusted People* store, and installs the
app. Windows then checks the `.appx`'s own digital signature against that trusted
certificate at install time, so the package's integrity is enforced by Windows —
the fingerprint check just authenticates the certificate you are trusting.

**Pros**

- A full install now, before the Store release: Start-menu entry, `.silverdaw`
  file association, and clean uninstall via **Settings ▸ Apps**.

**Cons**

- You must trust a self-signed certificate, which needs **administrator rights**
  — a deliberate security decision on your part.
- More steps than the Store.
- No automatic updates.

**About the certificate.** The `.cer` is the **public half only** — it contains
no private key and cannot be used to sign anything. It simply tells your PC to
trust app packages signed by `CN=Silverdaw`. You can remove it at any time (see
below). If you would rather not trust a certificate, use the **Microsoft Store**
or **portable** option instead.

**Uninstalling the self-signed install**

```powershell
# Remove the app:
Get-AppxPackage *Silverdaw* | Remove-AppxPackage

# Remove the trusted certificate (run elevated):
Get-ChildItem Cert:\LocalMachine\TrustedPeople |
  Where-Object { $_.Subject -eq 'CN=Silverdaw' } | Remove-Item
```

---

## Which should I choose?

- **Most people:** the **Microsoft Store** once it is live — it is the simplest
  and safest, with automatic updates.
- **Just want to try it now, with no install:** the **portable zip**.
- **Want a full local install before the Store release:** the **self-signed
  installer**, if you are comfortable trusting the certificate.

[releases]: https://github.com/irarainey/silverdaw/releases
