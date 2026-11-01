namespace Udc.Client;

/// <summary>Per-user app data locations, all under the roaming profile (e.g.
/// <c>%APPDATA%\UrbanDryCleanCRM</c> on Windows) - writable without admin rights, unlike the
/// install directory.</summary>
public static class Paths
{
    public static string AppDataRoot => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "UrbanDryCleanCRM");

    public static string ConfigFile => Path.Combine(AppDataRoot, "config.json");
    public static string TokenFile => Path.Combine(AppDataRoot, "token.bin");
    public static string UploadDir => Path.Combine(AppDataRoot, "uploads");
    public static string LogDir => Path.Combine(AppDataRoot, "logs");
    public static string LogFile => Path.Combine(LogDir, "app.log");

    public static void EnsureAppDataRoot() => Directory.CreateDirectory(AppDataRoot);
}
