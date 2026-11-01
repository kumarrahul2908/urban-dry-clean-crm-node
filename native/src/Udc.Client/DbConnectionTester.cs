using MySqlConnector;

namespace Udc.Client;

/// <summary>Result of a connection attempt: either <see cref="Ok"/>, or <see cref="Ok"/> is false
/// and <see cref="Error"/> explains why (shown as-is in the Setup window).</summary>
public readonly record struct ConnectionTestResult(bool Ok, string? Error)
{
    public static ConnectionTestResult Success() => new(true, null);
    public static ConnectionTestResult Failure(string error) => new(false, error);
}

/// <summary>Tests the MySQL/MariaDB connection the Setup window collects, directly from .NET
/// (no need to start the backend first) via the pure-managed MySqlConnector driver.</summary>
public static class DbConnectionTester
{
    public static async Task<ConnectionTestResult> TestAsync(AppConfig config, CancellationToken ct = default)
    {
        var builder = new MySqlConnectionStringBuilder
        {
            Server = string.IsNullOrWhiteSpace(config.DbHost) ? "127.0.0.1" : config.DbHost,
            Port = (uint)(config.DbPort <= 0 ? 3306 : config.DbPort),
            Database = config.DbName,
            UserID = config.DbUser,
            Password = config.DbPass ?? "",
            ConnectionTimeout = 5,
        };

        await using var conn = new MySqlConnection(builder.ConnectionString);
        try
        {
            await conn.OpenAsync(ct);
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT 1";
            await cmd.ExecuteScalarAsync(ct);
            return ConnectionTestResult.Success();
        }
        catch (MySqlException ex)
        {
            return ConnectionTestResult.Failure(ex.Message);
        }
        catch (Exception ex) when (ex is TimeoutException or OperationCanceledException)
        {
            return ConnectionTestResult.Failure("Connection timed out. Check the host/port and that the database server is reachable.");
        }
    }
}
