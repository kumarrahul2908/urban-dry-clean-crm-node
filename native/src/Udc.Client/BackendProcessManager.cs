using System.Diagnostics;

namespace Udc.Client;

/// <summary>
/// Starts and stops the bundled Node/Fastify backend as a child process - the native app's
/// equivalent of the Electron prototype's main.cjs. The backend is bundled under
/// <c>&lt;install dir&gt;/backend</c>: a portable Node runtime (<c>backend/node/node.exe</c>, so no
/// separate Node.js install is needed on the shop PC) plus the built backend
/// (<c>backend/dist/server.js</c>, <c>backend/public</c>, <c>backend/db</c>, <c>backend/node_modules</c>).
/// See native/scripts/prepare-backend.cjs, which stages all of that at build time.
/// </summary>
public sealed class BackendProcessManager : IDisposable
{
    private Process? _process;

    public static string BackendDir => Path.Combine(AppContext.BaseDirectory, "backend");
    public static string NodeExePath => Path.Combine(BackendDir, "node", "node.exe");
    public static string ServerScriptPath => Path.Combine(BackendDir, "dist", "server.js");

    public bool IsRunning => _process is { HasExited: false };

    public void Start(AppConfig config, Action<string> onLog)
    {
        if (IsRunning) return;

        var psi = new ProcessStartInfo
        {
            FileName = NodeExePath,
            WorkingDirectory = BackendDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.ArgumentList.Add(ServerScriptPath);
        foreach (var (key, value) in BuildEnvironment(config))
            psi.Environment[key] = value;

        var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, e) => { if (e.Data is not null) onLog($"[backend] {e.Data}"); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) onLog($"[backend:err] {e.Data}"); };
        process.Exited += (_, _) => onLog($"[backend] exited (code={SafeExitCode(process)})");

        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        _process = process;
    }

    private static int? SafeExitCode(Process p)
    {
        try { return p.ExitCode; } catch (InvalidOperationException) { return null; }
    }

    public static Dictionary<string, string> BuildEnvironment(AppConfig config)
    {
        var port = config.Port <= 0 ? 3100 : config.Port;
        return new Dictionary<string, string>
        {
            ["NODE_ENV"] = "production",
            ["PORT"] = port.ToString(),
            ["HOST"] = "127.0.0.1",
            ["DB_HOST"] = string.IsNullOrWhiteSpace(config.DbHost) ? "127.0.0.1" : config.DbHost,
            ["DB_PORT"] = config.DbPort <= 0 ? "3306" : config.DbPort.ToString(),
            ["DB_NAME"] = config.DbName,
            ["DB_USER"] = config.DbUser,
            ["DB_PASS"] = config.DbPass ?? "",
            ["APP_NAME"] = string.IsNullOrWhiteSpace(config.AppName) ? "URBAN DRY CLEAN" : config.AppName,
            ["APP_URL"] = $"http://127.0.0.1:{port}",
            ["APP_SECRET_KEY"] = config.AppSecretKey,
            ["UPLOAD_DIR"] = Paths.UploadDir,
            ["SERVE_UPLOADS"] = "true",
            ["TRUST_PROXY"] = "false",
        };
    }

    public async Task<bool> WaitForHealthAsync(int port, TimeSpan timeout, CancellationToken ct = default)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (!IsRunning) return false; // backend crashed before coming up
            try
            {
                var resp = await http.GetAsync($"http://127.0.0.1:{port}/health", ct);
                if (resp.IsSuccessStatusCode) return true;
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException) { /* not up yet */ }
            await Task.Delay(400, ct);
        }
        return false;
    }

    public void Stop()
    {
        var process = _process;
        _process = null;
        if (process is null) return;
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException) { /* already exited */ }
        finally { process.Dispose(); }
    }

    public void Dispose() => Stop();
}
