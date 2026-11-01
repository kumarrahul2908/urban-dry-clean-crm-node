using Udc.Client;
using Xunit;

namespace Udc.Client.Tests;

public class BackendProcessManagerTests
{
    [Fact]
    public void BuildEnvironment_MapsConfigToBackendEnvVars()
    {
        var config = new AppConfig
        {
            DbHost = "db.local",
            DbPort = 3307,
            DbName = "udc",
            DbUser = "shopuser",
            DbPass = "pw",
            AppName = "My Shop",
            AppSecretKey = "secret",
            Port = 3200,
        };

        var env = BackendProcessManager.BuildEnvironment(config);

        Assert.Equal("production", env["NODE_ENV"]);
        Assert.Equal("3200", env["PORT"]);
        Assert.Equal("127.0.0.1", env["HOST"]);
        Assert.Equal("db.local", env["DB_HOST"]);
        Assert.Equal("3307", env["DB_PORT"]);
        Assert.Equal("udc", env["DB_NAME"]);
        Assert.Equal("shopuser", env["DB_USER"]);
        Assert.Equal("pw", env["DB_PASS"]);
        Assert.Equal("My Shop", env["APP_NAME"]);
        Assert.Equal("http://127.0.0.1:3200", env["APP_URL"]);
        Assert.Equal("secret", env["APP_SECRET_KEY"]);
        Assert.Equal("true", env["SERVE_UPLOADS"]);
        Assert.Equal("false", env["TRUST_PROXY"]);
    }

    [Fact]
    public void BuildEnvironment_FillsSensibleDefaults_WhenFieldsAreBlankOrZero()
    {
        var config = new AppConfig { DbHost = "", DbPort = 0, DbName = "udc", DbUser = "root", AppName = "", Port = 0 };

        var env = BackendProcessManager.BuildEnvironment(config);

        Assert.Equal("127.0.0.1", env["DB_HOST"]);
        Assert.Equal("3306", env["DB_PORT"]);
        Assert.Equal("URBAN DRY CLEAN", env["APP_NAME"]);
        Assert.Equal("3100", env["PORT"]);
        Assert.Equal("http://127.0.0.1:3100", env["APP_URL"]);
    }
}
