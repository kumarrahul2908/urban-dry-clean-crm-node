using System.Text.Json;

namespace Udc.Client;

/// <summary>Loads/saves <see cref="AppConfig"/> as JSON at <see cref="Paths.ConfigFile"/>.</summary>
public static class ConfigStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    public static AppConfig? Load()
    {
        try
        {
            var json = File.ReadAllText(Paths.ConfigFile);
            var cfg = JsonSerializer.Deserialize<AppConfig>(json);
            return cfg is { IsComplete: true } ? cfg : null;
        }
        catch (IOException) { return null; }
        catch (JsonException) { return null; }
    }

    public static void Save(AppConfig config)
    {
        Paths.EnsureAppDataRoot();
        File.WriteAllText(Paths.ConfigFile, JsonSerializer.Serialize(config, JsonOptions));
    }
}
