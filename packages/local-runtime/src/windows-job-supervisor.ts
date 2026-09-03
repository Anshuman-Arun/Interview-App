/**
 * Windows-only trusted process bootstrap components.
 *
 * The C# helper is compiled once by the application, then each one-shot
 * PowerShell bootstrap verifies and loads the exact compiled bytes before
 * using the helper to create the provider suspended inside a kill-on-close
 * Job Object. Provider input is never part of the helper source.
 */
export const WINDOWS_JOB_SUPERVISOR_CSHARP_SOURCE = String.raw`
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
    private const uint DUPLICATE_SAME_ACCESS = 0x00000002;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint WAIT_OBJECT_0 = 0x00000000;
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

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(
        IntPtr sourceProcess,
        IntPtr sourceHandle,
        IntPtr targetProcess,
        out IntPtr targetHandle,
        uint desiredAccess,
        bool inheritHandle,
        uint options);

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

    private static IntPtr DuplicateInheritable(IntPtr source)
    {
        if (source == IntPtr.Zero || source == new IntPtr(-1))
            throw new InvalidOperationException("standard handle unavailable");

        IntPtr duplicate;
        IntPtr currentProcess = GetCurrentProcess();
        if (!DuplicateHandle(
            currentProcess,
            source,
            currentProcess,
            out duplicate,
            0,
            true,
            DUPLICATE_SAME_ACCESS))
        {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        return duplicate;
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
        string expectedSha256,
        string stdinPath,
        long expectedStdinBytes,
        string expectedStdinSha256)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr process = IntPtr.Zero;
        IntPtr thread = IntPtr.Zero;
        bool resumed = false;
        try
        {
            Console.Error.WriteLine("INTERVIEW_SUPERVISOR_STAGE:RUN_ENTER");
            using (FileStream executableLock = new FileStream(
                executable,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read))
            using (FileStream stdinLock = new FileStream(
                stdinPath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read))
            {
                if (stdinLock.Length != expectedStdinBytes)
                    throw new InvalidOperationException("stdin length mismatch");

                string actualStdinSha256 = Sha256Hex(stdinLock);
                if (!String.Equals(
                    actualStdinSha256,
                    expectedStdinSha256,
                    StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException("stdin identity mismatch");
                }
                stdinLock.Position = 0;
                Console.Error.WriteLine("INTERVIEW_SUPERVISOR_STAGE:INPUT_OK");

                string actualSha256 = Sha256Hex(executableLock);
                if (!String.Equals(
                    actualSha256,
                    expectedSha256,
                    StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException("executable identity mismatch");
                }

                Console.Error.WriteLine("INTERVIEW_SUPERVISOR_STAGE:EXE_OK");
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

            Console.Error.WriteLine("INTERVIEW_SUPERVISOR_STAGE:JOB_OK");
            IntPtr childStdin = IntPtr.Zero;
            IntPtr childStdout = IntPtr.Zero;
            IntPtr childStderr = IntPtr.Zero;
            var startup = new STARTUPINFOEX();
            IntPtr handleList = IntPtr.Zero;
            try
            {
                // Never mutate the bootstrap's own std-handle inheritance flags.
                // Node/PowerShell may back those handles with runtime-owned pipe
                // objects. Give the provider fresh, explicitly inheritable
                // duplicates and admit only those duplicates through the
                // STARTUPINFOEX handle allow-list.
                childStdin = DuplicateInheritable(
                    stdinLock.SafeFileHandle.DangerousGetHandle());
                childStdout = DuplicateInheritable(GetStdHandle(STD_OUTPUT_HANDLE));
                childStderr = DuplicateInheritable(GetStdHandle(STD_ERROR_HANDLE));

                Console.Error.WriteLine("INTERVIEW_SUPERVISOR_STAGE:HANDLES_OK");
                startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
                startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = childStdin;
                startup.StartupInfo.hStdOutput = childStdout;
                startup.StartupInfo.hStdError = childStderr;

                IntPtr attributeSize = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
                if (attributeSize == IntPtr.Zero)
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

                startup.lpAttributeList = Marshal.AllocHGlobal(attributeSize);
                handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
                if (!InitializeProcThreadAttributeList(
                    startup.lpAttributeList,
                    1,
                    0,
                    ref attributeSize))
                {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }

                Marshal.WriteIntPtr(handleList, 0 * IntPtr.Size, childStdin);
                Marshal.WriteIntPtr(handleList, 1 * IntPtr.Size, childStdout);
                Marshal.WriteIntPtr(handleList, 2 * IntPtr.Size, childStderr);

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
                Console.Error.WriteLine("INTERVIEW_SUPERVISOR_STAGE:CREATE_OK");
            }
            finally
            {
                if (startup.lpAttributeList != IntPtr.Zero)
                {
                    DeleteProcThreadAttributeList(startup.lpAttributeList);
                    Marshal.FreeHGlobal(startup.lpAttributeList);
                }
                if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
                if (childStdin != IntPtr.Zero) CloseHandle(childStdin);
                if (childStdout != IntPtr.Zero) CloseHandle(childStdout);
                if (childStderr != IntPtr.Zero) CloseHandle(childStderr);
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

            Console.Error.WriteLine("INTERVIEW_SUPERVISOR_STAGE:ASSIGN_OK");
            if (ResumeThread(thread) == 0xFFFFFFFF)
            {
                TerminateProcess(process, 194);
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
            resumed = true;
            Console.Error.WriteLine("INTERVIEW_SUPERVISOR_STAGE:RESUME_OK");

            if (WaitForSingleObject(process, INFINITE) != WAIT_OBJECT_0)
            {
                TerminateProcess(process, 195);
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }

            Console.Error.WriteLine("INTERVIEW_SUPERVISOR_STAGE:WAIT_OK");
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
`;

export const WINDOWS_JOB_SUPERVISOR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$stageDebugPath = $env:INTERVIEW_SUPERVISOR_STAGE_DEBUG_FILE
function Write-InterviewSupervisorStage([string]$stage) {
  if (-not [string]::IsNullOrWhiteSpace($stageDebugPath)) {
    [System.IO.File]::AppendAllText(
      $stageDebugPath,
      "INTERVIEW_SUPERVISOR_STAGE:" + $stage + [Environment]::NewLine
    )
  }
}
Write-InterviewSupervisorStage "PS_ENTER"

$configJson = $env:INTERVIEW_SUPERVISED_CONFIG_JSON
$assemblyPath = $env:INTERVIEW_SUPERVISED_ASSEMBLY_PATH
$assemblySha256 = $env:INTERVIEW_SUPERVISED_ASSEMBLY_SHA256
Write-InterviewSupervisorStage "PS_ENV_READ"
if (
  [string]::IsNullOrWhiteSpace($configJson) -or
  [string]::IsNullOrWhiteSpace($assemblyPath) -or
  [string]::IsNullOrWhiteSpace($assemblySha256)
) {
  exit 191
}
Write-InterviewSupervisorStage "PS_REQUIRED_OK"
[Environment]::SetEnvironmentVariable("INTERVIEW_SUPERVISED_CONFIG_JSON", $null, "Process")
Write-InterviewSupervisorStage "PS_REMOVE_CONFIG"
[Environment]::SetEnvironmentVariable("INTERVIEW_SUPERVISED_ASSEMBLY_PATH", $null, "Process")
Write-InterviewSupervisorStage "PS_REMOVE_PATH"
[Environment]::SetEnvironmentVariable("INTERVIEW_SUPERVISED_ASSEMBLY_SHA256", $null, "Process")
Write-InterviewSupervisorStage "PS_REMOVE_SHA"
[Environment]::SetEnvironmentVariable("INTERVIEW_SUPERVISED_BOOTSTRAP", $null, "Process")
Write-InterviewSupervisorStage "PS_REMOVE_BOOTSTRAP"
[Environment]::SetEnvironmentVariable("INTERVIEW_SUPERVISOR_STAGE_DEBUG_FILE", $null, "Process")
Write-InterviewSupervisorStage "PS_CONFIG_OK"

$config = $configJson | ConvertFrom-Json
Write-InterviewSupervisorStage "PS_JSON_OK"
$configJson = $null

$stream = New-Object System.IO.FileStream(
  $assemblyPath,
  [System.IO.FileMode]::Open,
  [System.IO.FileAccess]::Read,
  [System.IO.FileShare]::Read
)
Write-InterviewSupervisorStage "PS_STREAM_OPEN"
try {
  if ($stream.Length -le 0 -or $stream.Length -gt 5242880) {
    exit 190
  }
  Write-InterviewSupervisorStage "PS_STREAM_SIZE_OK"

  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha.ComputeHash($stream)
  }
  finally {
    $sha.Dispose()
  }
  Write-InterviewSupervisorStage "PS_HASH_OK"
  $actualSha256 = ([System.BitConverter]::ToString($digest)).Replace("-", "").ToLowerInvariant()
  if (-not [string]::Equals(
    $actualSha256,
    $assemblySha256,
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    exit 190
  }
  Write-InterviewSupervisorStage "PS_HASH_MATCH"

  $stream.Position = 0
  $bytes = New-Object byte[] ([int]$stream.Length)
  $offset = 0
  while ($offset -lt $bytes.Length) {
    $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
    if ($read -le 0) {
      exit 190
    }
    $offset += $read
  }
  Write-InterviewSupervisorStage "PS_READ_OK"
}
finally {
  $stream.Dispose()
}
Write-InterviewSupervisorStage "PS_BYTES_OK"

try {
  $assembly = [System.Reflection.Assembly]::Load($bytes)
  $supervisorType = $assembly.GetType("InterviewJobSupervisor", $true, $false)
  $runMethod = $supervisorType.GetMethod(
    "Run",
    [System.Reflection.BindingFlags]::Public -bor [System.Reflection.BindingFlags]::Static
  )
  if ($null -eq $runMethod) {
    exit 190
  }
}
catch {
  exit 190
}
Write-InterviewSupervisorStage "PS_METHOD_OK"

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
Write-InterviewSupervisorStage "PS_ENV_OK"

try {
  $invokeArguments = New-Object object[] 7
  $invokeArguments[0] = [string]$config.executable
  $invokeArguments[1] = [string[]]$arguments
  $invokeArguments[2] = $currentDirectory
  $invokeArguments[3] = [string]$config.expectedSha256
  $invokeArguments[4] = [string]$config.stdinPath
  $invokeArguments[5] = [long]$config.stdinBytes
  $invokeArguments[6] = [string]$config.stdinSha256
  Write-InterviewSupervisorStage "PS_INVOKE"
  $exitCode = [int]$runMethod.Invoke($null, $invokeArguments)
  Write-InterviewSupervisorStage "PS_RETURN"
  exit $exitCode
}
catch {
  exit 192
}
`;
