namespace Udc.Client;

/// <summary>
/// Everything the app needs to start the local backend and reach its MySQL database.
/// Stored as JSON in the per-user app data folder (see <see cref="ConfigStore"/>), not inside
/// the install directory, which isn't writable without admin rights once installed.
/// </summary>
public sealed class AppConfig
{
    public string DbHost { get; set; } = "127.0.0.1";
    public int DbPort { get; set; } = 3306;
    public string DbName { get; set; } = "";
    public string DbUser { get; set; } = "";
    public string DbPass { get; set; } = "";
    public string AppName { get; set; } = "URBAN DRY CLEAN";
    public string AppSecretKey { get; set; } = "";
    public int Port { get; set; } = 3100;

    public bool IsComplete => !string.IsNullOrWhiteSpace(DbName) && !string.IsNullOrWhiteSpace(DbUser);

    /// <summary>
    /// Merges a submitted (possibly partial) config over the previously-saved one: a blank
    /// password or secret key on a later edit means "keep what's already there", not "erase it".
    /// Only a true first run (no prior config at all) treats a blank secret key as "generate one".
    /// </summary>
    public static AppConfig Merge(AppConfig? existing, AppConfig submitted)
    {
        var merged = new AppConfig
        {
            DbHost = submitted.DbHost,
            DbPort = submitted.DbPort,
            DbName = submitted.DbName,
            DbUser = submitted.DbUser,
            DbPass = string.IsNullOrEmpty(submitted.DbPass) ? (existing?.DbPass ?? "") : submitted.DbPass,
            AppName = submitted.AppName,
            Port = submitted.Port,
        };
        merged.AppSecretKey = !string.IsNullOrWhiteSpace(submitted.AppSecretKey)
            ? submitted.AppSecretKey
            : (!string.IsNullOrWhiteSpace(existing?.AppSecretKey) ? existing!.AppSecretKey : GenerateSecretKey());
        return merged;
    }

    public static string GenerateSecretKey()
    {
        var bytes = System.Security.Cryptography.RandomNumberGenerator.GetBytes(32);
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }
}
