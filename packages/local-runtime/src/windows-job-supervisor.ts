/**
 * Windows-only bootstrap used by SupervisedProcessRunner.
 *
 * The bootstrap creates the provider suspended, assigns it to a Job Object
 * configured with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, and only then resumes it.
 * The Job handle is held only by the bootstrap process, so terminating or
 * crashing the bootstrap closes the handle and the kernel terminates every
 * process that remains in the job.
 */
export const WINDOWS_JOB_SUPERVISOR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'

$configPath = $env:INTERVIEW_SUPERVISED_CONFIG
if ([string]::IsNullOrWhiteSpace($configPath)) {
  exit 191
}
Remove-Item Env:INTERVIEW_SUPERVISED_CONFIG -ErrorAction SilentlyContinue
Remove-Item Env:INTERVIEW_SUPERVISED_BOOTSTRAP -ErrorAction SilentlyContinue

$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
Remove-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue

$source = @'
using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Runtime.InteropServices;

public static class InterviewJobSupervisor
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const int PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int infoClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFOEX startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        int flags,
        ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        IntPtr size,
        IntPtr previousValue,
        IntPtr returnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(
        IntPtr handle,
        uint mask,
        uint flags);

    private static string Quote(string value)
    {
        if (value.Length == 0) return "\"\"";
        bool needsQuotes = false;
        for (int i = 0; i < value.Length; i++)
        {
            char ch = value[i];
            if (char.IsWhiteSpace(ch) || ch == '"')
            {
                needsQuotes = true;
                break;
            }
        }
        if (!needsQuotes) return value;

        var builder = new StringBuilder();
        builder.Append('"');
        int backslashes = 0;
        foreach (char ch in value)
        {
            if (ch == '\\')
            {
                backslashes++;
                continue;
            }
            if (ch == '"')
            {
                builder.Append('\\', backslashes * 2 + 1);
                builder.Append('"');
                backslashes = 0;
                continue;
            }
            builder.Append('\\', backslashes);
            backslashes = 0;
            builder.Append(ch);
        }
        builder.Append('\\', backslashes * 2);
        builder.Append('"');
        return builder.ToString();
    }

    private static StringBuilder CommandLine(string executable, string[] arguments)
    {
        var builder = new StringBuilder();
        builder.Append(Quote(executable));
        foreach (string argument in arguments)
        {
            builder.Append(' ');
            builder.Append(Quote(argument ?? ""));
        }
        return builder;
    }

    private static void RequireInheritable(IntPtr handle)
    {
        if (handle == IntPtr.Zero || handle == new IntPtr(-1))
            throw new InvalidOperationException("standard handle unavailable");
        if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }

    private static string Sha256Hex(Stream stream)
    {
        using (SHA256 algorithm = SHA256.Create())
        {
            byte[] digest = algorithm.ComputeHash(stream);
            var output = new StringBuilder(digest.Length * 2);
            foreach (byte value in digest)
                output.Append(value.ToString("x2"));
            return output.ToString();
        }
    }

    public static int Run(
        string executable,
        string[] arguments,
        string currentDirectory,
        string expectedSha256)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr process = IntPtr.Zero;
        IntPtr thread = IntPtr.Zero;
        bool resumed = false;
        try
        {
            using (FileStream executableLock = new FileStream(
                executable,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read))
            {
                string actualSha256 = Sha256Hex(executableLock);
                if (!String.Equals(
                    actualSha256,
                    expectedSha256,
                    StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException("executable identity mismatch");
                }

                job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr limitsPointer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, limitsPointer, false);
                if (!SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    limitsPointer,
                    (uint)size))
                {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }
            }
            finally
            {
                Marshal.FreeHGlobal(limitsPointer);
            }

            IntPtr stdin = GetStdHandle(STD_INPUT_HANDLE);
            IntPtr stdout = GetStdHandle(STD_OUTPUT_HANDLE);
            IntPtr stderr = GetStdHandle(STD_ERROR_HANDLE);
            RequireInheritable(stdin);
            RequireInheritable(stdout);
            RequireInheritable(stderr);

            var startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = stdin;
            startup.StartupInfo.hStdOutput = stdout;
            startup.StartupInfo.hStdError = stderr;

            IntPtr attributeSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
            if (attributeSize == IntPtr.Zero)
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

            startup.lpAttributeList = Marshal.AllocHGlobal(attributeSize);
            IntPtr handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
            try
            {
                if (!InitializeProcThreadAttributeList(
                    startup.lpAttributeList,
                    1,
                    0,
                    ref attributeSize))
                {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }

                Marshal.WriteIntPtr(handleList, 0 * IntPtr.Size, stdin);
                Marshal.WriteIntPtr(handleList, 1 * IntPtr.Size, stdout);
                Marshal.WriteIntPtr(handleList, 2 * IntPtr.Size, stderr);

                if (!UpdateProcThreadAttribute(
                    startup.lpAttributeList,
                    0,
                    new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST),
                    handleList,
                    new IntPtr(IntPtr.Size * 3),
                    IntPtr.Zero,
                    IntPtr.Zero))
                {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }

                PROCESS_INFORMATION info;
                if (!CreateProcessW(
                    executable,
                    CommandLine(executable, arguments ?? new string[0]),
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                    IntPtr.Zero,
                    String.IsNullOrEmpty(currentDirectory) ? null : currentDirectory,
                    ref startup,
                    out info))
                {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }
                process = info.hProcess;
                thread = info.hThread;
            }
            finally
            {
                if (startup.lpAttributeList != IntPtr.Zero)
                {
                    DeleteProcThreadAttributeList(startup.lpAttributeList);
                    Marshal.FreeHGlobal(startup.lpAttributeList);
                }
                Marshal.FreeHGlobal(handleList);
            }

            executableLock.Position = 0;
            string postCreateSha256 = Sha256Hex(executableLock);
            if (!String.Equals(
                postCreateSha256,
                expectedSha256,
                StringComparison.OrdinalIgnoreCase))
            {
                TerminateProcess(process, 197);
                throw new InvalidOperationException("executable changed during process creation");
            }

            if (!AssignProcessToJobObject(job, process))
            {
                TerminateProcess(process, 193);
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }

            if (ResumeThread(thread) == 0xFFFFFFFF)
            {
                TerminateProcess(process, 194);
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
            resumed = true;

            if (WaitForSingleObject(process, INFINITE) != WAIT_OBJECT_0)
            {
                TerminateProcess(process, 195);
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }

            uint exitCode;
            if (!GetExitCodeProcess(process, out exitCode))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

                return unchecked((int)exitCode);
            }
        }
        finally
        {
            if (!resumed && process != IntPtr.Zero)
                TerminateProcess(process, 196);
            if (thread != IntPtr.Zero) CloseHandle(thread);
            if (process != IntPtr.Zero) CloseHandle(process);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp

$allowed = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($name in $config.environmentKeys) {
  [void]$allowed.Add([string]$name)
}
foreach ($name in @([Environment]::GetEnvironmentVariables().Keys)) {
  if (-not $allowed.Contains([string]$name)) {
    [Environment]::SetEnvironmentVariable([string]$name, $null, 'Process')
  }
}

$arguments = @()
foreach ($argument in $config.arguments) {
  $arguments += [string]$argument
}
$currentDirectory = if ($null -eq $config.cwd) { $null } else { [string]$config.cwd }

try {
  $exitCode = [InterviewJobSupervisor]::Run(
    [string]$config.executable,
    [string[]]$arguments,
    $currentDirectory,
    [string]$config.expectedSha256
  )
  exit $exitCode
}
catch {
  exit 192
}
`;
