package io.junjo.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class IdsTest {
    static final UUID U = UUID.fromString("2F0C1A3B-4D5E-6F70-8192-A3B4C5D6E7F8");

    @Test
    void rejectsBadNamespaces() {
        assertThrows(IllegalArgumentException.class, () -> Ids.namespaced("NS", U));
        assertThrows(IllegalArgumentException.class, () -> Ids.namespaced("", U));
        assertThrows(IllegalArgumentException.class, () -> Ids.namespaced("a:b", U));
    }

    @Test
    void canonicalizesAndParses() {
        assertEquals("ns:2f0c1a3b-4d5e-6f70-8192-a3b4c5d6e7f8", Ids.namespaced("ns", U));
        assertEquals("ns:2f0c1a3b-4d5e-6f70-8192-a3b4c5d6e7f8",
                Ids.canonicalize("ns:2F0C1A3B4D5E6F708192A3B4C5D6E7F8"));
        assertEquals("ns:2f0c1a3b-4d5e-6f70-8192-a3b4c5d6e7f8",
                Ids.canonicalize("ns:2F0C1A3B-4D5E-6F70-8192-A3B4C5D6E7F8"));
        assertEquals(Optional.of(U), Ids.uuidOf("ns:2f0c1a3b-4d5e-6f70-8192-a3b4c5d6e7f8", "ns"));
        assertEquals(Optional.empty(), Ids.uuidOf("ns:2F0C1A3B-4D5E-6F70-8192-A3B4C5D6E7F8", "ns"));
        assertEquals(Optional.of("web"), Ids.namespaceOf("web:a:b"));
        assertEquals(Optional.empty(), Ids.namespaceOf("plain"));
        assertTrue(Ids.isCanonicalUuidId("ns:2f0c1a3b-4d5e-6f70-8192-a3b4c5d6e7f8"));
        assertFalse(Ids.isCanonicalUuidId("ns:nope"));
        assertThrows(IllegalArgumentException.class, () -> Ids.canonicalize("ns:not-a-uuid"));
    }
}
