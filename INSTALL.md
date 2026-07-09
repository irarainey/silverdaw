# Installing Silverdaw

Silverdaw is a Windows desktop application (Windows 10 version 1809 or later, or
Windows 11, 64-bit). There are two ways to install it. The **Microsoft Store**
is the easiest and recommended option.

| Option | Best for | Effort | Updates | Windows integration\* |
| ------ | -------- | ------ | ------------ | --------------------- |
| **[Microsoft Store][store]** | Everyone | One click | Automatic | Full |
| **Portable download** (zip) | Trying it quickly, no install | Unzip & run | Manual | None

\* *Windows integration* = a Start-menu entry, the `.silverdaw` file association
(double-click a project to open it), and an entry in **Settings ▸ Apps** for a
clean uninstall.

---

## 1. Microsoft Store — recommended

Install Silverdaw in one click from the Microsoft Store:

- **[apps.microsoft.com/detail/9N8T25L0462F][store]**

Microsoft signs and distributes the package, so there are no security prompts, and updates arrive automatically.

**Pros**

- Easiest install — one click, no setup.
- No security warnings.
- Automatic updates.
- Clean install and uninstall managed by Windows.
- Full Windows integration (Start menu + file association).

**Cons**

- None to speak of — this is the recommended option for most people.

---

## 2. Portable download (zip)

Download `Silverdaw-<version>.zip` from the [latest release][releases], extract it
to any folder you can write to, and run `Silverdaw.exe`. Nothing is installed.

**Pros**

- No installation, no administrator rights.
- Runs from anywhere — a normal folder, an external drive, etc.
- Trivial to remove: just delete the extracted folder.

**Cons**

- The first launch will likely show a Windows SmartScreen prompt
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

## Which should I choose?

- **Most people:** the **[Microsoft Store][store]** — it is the simplest
  and safest, with automatic updates.
- **Just want to try it now, with no install:** the **portable zip**.

---

## Troubleshooting: Silverdaw won't start

Silverdaw needs its background audio engine to run; if that fails to start you
may see a *"could not connect to the audio engine"* message. To make this easy to
diagnose, **every launch** writes a small diagnostics log — and a crash report if
the engine faults — to a fixed folder, whether or not diagnostic logging is turned
on in Preferences.

Open this folder (paste the path into File Explorer's address bar):

```text
%USERPROFILE%\Silverdaw\Diagnostics
```

It contains:

- `startup.log` — a short record of the last launch (app version, backend spawn).
- `backend.log` — the engine's own startup log for the last launch.
- `backend-crash-<timestamp>.log` — written **only** if the engine crashed on
  startup, with the failure details. It's timestamped, so a crash report isn't
  overwritten by the next launch.

`startup.log` and `backend.log` are overwritten on each launch (they don't grow
over time). If you
report a startup problem, attaching them helps pin down the cause.

If Silverdaw does start but you hit a problem, turn on **Preferences ▸ Developer ▸
Write diagnostic logs**, reproduce the issue, then use **Help ▸ Send Diagnostic
Logs** — it bundles the current session's logs into a zip (saved in your
`Silverdaw\Logs` folder), reveals it in File Explorer, and opens a pre-filled email
to **support@silverdaw.com** for you to attach the zip and send. You can also email
that address directly, or from the About dialog (**Help ▸ About Silverdaw**).

Diagnostic logs are written with privacy in mind: your Windows user name is stripped
out of any file paths they contain, and your computer name is never recorded — so a
log you share carries nothing that identifies you.

[releases]: https://github.com/irarainey/silverdaw/releases
[store]: https://apps.microsoft.com/detail/9N8T25L0462F
