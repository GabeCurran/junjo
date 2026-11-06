package io.junjo.sdk.model;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Base of the request inputs. An input records only the fields the caller set, so an absent field
 * is omitted from the JSON body while a field set to null is sent as JSON null (which several
 * routes read as "clear").
 */
public abstract class RequestBody {
    private final Map<String, Object> fields;

    protected RequestBody(Map<String, Object> fields) {
        this.fields = Collections.unmodifiableMap(new LinkedHashMap<>(fields));
    }

    /** The body fields, in insertion order; values are plain Java values. */
    public Map<String, Object> fields() {
        return fields;
    }

    @Override
    public String toString() {
        return getClass().getSimpleName() + fields;
    }
}
