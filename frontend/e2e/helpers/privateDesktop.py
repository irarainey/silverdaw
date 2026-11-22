"""Start an E2E process on the named Windows desktop with its original pipes."""

import ctypes
from ctypes import wintypes as w
import shutil
import subprocess
import sys


class StartupInfo(ctypes.Structure):
    _fields_ = [
        ("cb", w.DWORD), ("reserved", w.LPWSTR), ("desktop", w.LPWSTR),
        ("title", w.LPWSTR), ("geometry", w.DWORD * 7), ("flags", w.DWORD),
        ("show", w.WORD), ("reserved_size", w.WORD), ("reserved_data", w.LPVOID),
        ("stdin", w.HANDLE), ("stdout", w.HANDLE), ("stderr", w.HANDLE),
    ]


class ProcessInfo(ctypes.Structure):
    _fields_ = [("process", w.HANDLE), ("thread", w.HANDLE),
                ("pid", w.DWORD), ("tid", w.DWORD)]


def main():
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    create = user32.CreateDesktopW
    create.argtypes = [w.LPCWSTR, w.LPVOID, w.LPVOID, w.DWORD, w.DWORD, w.LPVOID]
    create.restype = w.HANDLE
    user32.CloseDesktop.argtypes = [w.HANDLE]
    kernel.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, w.LPVOID, w.LPVOID,
                                     w.BOOL, w.DWORD, w.LPVOID, w.LPCWSTR,
                                     ctypes.POINTER(StartupInfo), ctypes.POINTER(ProcessInfo)]
    kernel.GetStdHandle.restype = w.HANDLE
    kernel.CloseHandle.argtypes = [w.HANDLE]
    kernel.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
    kernel.GetExitCodeProcess.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
    name, program, *arguments = sys.argv[1:]
    exe = shutil.which(program)
    if not exe:
        raise FileNotFoundError(program)
    desktop = create(name, None, None, 0, 0x10000000, None)  # GENERIC_ALL
    if not desktop:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        info = StartupInfo(cb=ctypes.sizeof(StartupInfo), desktop=name, flags=0x100,
                           stdin=kernel.GetStdHandle(-10), stdout=kernel.GetStdHandle(-11),
                           stderr=kernel.GetStdHandle(-12))
        process = ProcessInfo()
        args = ctypes.create_unicode_buffer(subprocess.list2cmdline([exe, *arguments]))
        if not kernel.CreateProcessW(exe, args, None, None, True, 0, None, None,
                                     ctypes.byref(info), ctypes.byref(process)):
            raise ctypes.WinError(ctypes.get_last_error())
        kernel.CloseHandle(process.thread)
        try:
            code = w.DWORD()
            if kernel.WaitForSingleObject(process.process, 0xffffffff) != 0 or not \
                    kernel.GetExitCodeProcess(process.process, ctypes.byref(code)):
                raise ctypes.WinError(ctypes.get_last_error())
            return code.value
        finally:
            kernel.CloseHandle(process.process)
    finally:
        user32.CloseDesktop(desktop)


if __name__ == "__main__":
    sys.exit(main())
