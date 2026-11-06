package io.junjo.sdk;

import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.fail;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.junjo.sdk.internal.Call;
import io.junjo.sdk.internal.HttpResult;
import io.junjo.sdk.model.CreateGroupInput;
import io.junjo.sdk.model.Group;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.UUID;

/**
 * Helpers for the live tests, which run only when {@code JUNJO_IT_BASE_URL} and
 * {@code JUNJO_IT_API_KEY} name a disposable game. Every test creates its own uniquely named
 * groups and ids.
 */
public final class LiveSupport {
    private LiveSupport() {}

    public static JunjoClient client() {
        return client(System.getenv("JUNJO_IT_API_KEY"));
    }

    public static JunjoClient client(String key) {
        return JunjoClient.builder()
                .baseUrl(System.getenv("JUNJO_IT_BASE_URL"))
                .apiKey(key)
                .requestTimeout(Duration.ofSeconds(15))
                .build();
    }

    public static String user() {
        return Ids.namespaced("it", UUID.randomUUID());
    }

    public static String unique() {
        return UUID.randomUUID().toString().substring(0, 12);
    }

    public static Group group(JunjoClient client, String kind) throws Exception {
        return join(client.groups().create(CreateGroupInput.builder(kind, "java-it-" + unique()).build()));
    }

    public static String gameId(JunjoClient client) throws Exception {
        HttpResult who = join(TestSupport.transport(client).send(Call.get("/v1/whoami")));
        return JsonParser.parseString(who.bodyString()).getAsJsonObject().get("gameId").getAsString();
    }

    /** Admin routes are not part of the SDK; the tests call them directly. */
    public static JsonObject admin(String method, String path, String body) throws Exception {
        try (HttpClient http = HttpClient.newHttpClient()) {
            HttpRequest req = HttpRequest.newBuilder(URI.create(System.getenv("JUNJO_IT_BASE_URL") + path))
                    .timeout(Duration.ofSeconds(15))
                    .header("Authorization", "Bearer " + System.getenv("JUNJO_IT_ADMIN_TOKEN"))
                    .header("Content-Type", "application/json")
                    .method(method, body == null
                            ? HttpRequest.BodyPublishers.noBody()
                            : HttpRequest.BodyPublishers.ofString(body))
                    .build();
            HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() >= 300) {
                fail("admin " + method + " " + path + " answered " + res.statusCode() + ": " + res.body());
            }
            return res.body().isEmpty() ? new JsonObject() : JsonParser.parseString(res.body()).getAsJsonObject();
        }
    }
}
