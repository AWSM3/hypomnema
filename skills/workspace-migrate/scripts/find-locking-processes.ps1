param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

$ErrorActionPreference = "Stop"

$resolved = (Resolve-Path -LiteralPath $Path).Path

if (-not ([System.Management.Automation.PSTypeName]"WorkspaceRestartManager").Type) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class WorkspaceRestartManager
{
    const int ERROR_MORE_DATA = 234;
    const int CCH_RM_SESSION_KEY = 32;

    [StructLayout(LayoutKind.Sequential)]
    public struct RM_UNIQUE_PROCESS
    {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    public enum RM_APP_TYPE
    {
        RmUnknownApp = 0,
        RmMainWindow = 1,
        RmOtherWindow = 2,
        RmService = 3,
        RmExplorer = 4,
        RmConsole = 5,
        RmCritical = 1000
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct RM_PROCESS_INFO
    {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string strServiceShortName;
        public RM_APP_TYPE ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint sessionHandle, int sessionFlags,
        string sessionKey);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint sessionHandle,
        uint fileCount, string[] fileNames,
        uint applicationCount, RM_UNIQUE_PROCESS[] applications,
        uint serviceCount, string[] serviceNames);

    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint sessionHandle,
        out uint processInfoNeeded, ref uint processInfo,
        [In, Out] RM_PROCESS_INFO[] affectedApps,
        ref uint rebootReasons);

    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint sessionHandle);

    public static RM_PROCESS_INFO[] Find(string[] paths)
    {
        uint handle;
        string key = Guid.NewGuid().ToString("N").Substring(0, CCH_RM_SESSION_KEY);
        int result = RmStartSession(out handle, 0, key);
        if (result != 0) throw new InvalidOperationException("RmStartSession: " + result);

        try
        {
            result = RmRegisterResources(handle, (uint)paths.Length, paths, 0, null, 0, null);
            if (result != 0) throw new InvalidOperationException("RmRegisterResources: " + result);

            uint needed = 0;
            uint count = 0;
            uint reasons = 0;
            result = RmGetList(handle, out needed, ref count, null, ref reasons);
            if (result == 0) return new RM_PROCESS_INFO[0];
            if (result != ERROR_MORE_DATA) throw new InvalidOperationException("RmGetList: " + result);

            var processes = new RM_PROCESS_INFO[needed];
            count = needed;
            result = RmGetList(handle, out needed, ref count, processes, ref reasons);
            if (result != 0) throw new InvalidOperationException("RmGetList: " + result);
            if (count == processes.Length) return processes;

            var exact = new RM_PROCESS_INFO[count];
            Array.Copy(processes, exact, count);
            return exact;
        }
        finally
        {
            RmEndSession(handle);
        }
    }
}
'@
}

$item = Get-Item -LiteralPath $resolved
$resources = if ($item.PSIsContainer) {
    @(Get-ChildItem -LiteralPath $resolved -Recurse -Force -File | ForEach-Object { $_.FullName })
} else {
    @($resolved)
}
if ($resources.Count -eq 0) {
    $resources = @($resolved)
}

$processes = [WorkspaceRestartManager]::Find([string[]]$resources)
$result = foreach ($item in $processes) {
    $process = Get-Process -Id $item.Process.dwProcessId -ErrorAction SilentlyContinue
    [pscustomobject]@{
        Path = $resolved
        ProcessId = $item.Process.dwProcessId
        ProcessName = if ($process) { $process.ProcessName } else { $item.strAppName }
        ApplicationName = $item.strAppName
        ApplicationType = [string]$item.ApplicationType
        Restartable = $item.bRestartable
    }
}

[pscustomobject]@{
    ok = $true
    path = $resolved
    locking_processes = @($result)
} | ConvertTo-Json -Depth 4
