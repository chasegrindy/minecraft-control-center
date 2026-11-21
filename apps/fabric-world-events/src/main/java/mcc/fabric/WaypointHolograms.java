package mcc.fabric;

import com.google.gson.JsonParser;
import com.google.gson.JsonObject;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.CommandDispatcher;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.Comparator;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtOps;
import net.minecraft.commands.Commands;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.ComponentSerialization;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.ProblemReporter;
import net.minecraft.world.entity.Display;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.storage.TagValueInput;
import net.minecraft.world.level.storage.ValueOutput;
import org.slf4j.LoggerFactory;

final class WaypointHolograms {
    private static final int MAX_BYTES = 65_536;
    private final Path file;
    private final Map<Waypoint, Display.TextDisplay> displays = new HashMap<>();
    private final Map<UUID, String> targets = new HashMap<>();
    private static final String[] DIRECTIONS = {"↑", "↗", "→", "↘", "↓", "↙", "←", "↖"};
    private static final int PAGE_SIZE = 8;
    private Map<String, Waypoint> points = Map.of();
    private CompletableFuture<Map<String, Waypoint>> reading;
    private int ticks;

    private record Waypoint(String name, String category, ResourceKey<Level> dimension, int x, int y, int z) {}

    private WaypointHolograms(Path file) {
        this.file = file;
    }

    static void register() {
        String file = System.getenv("MCC_WAYPOINTS_FILE");
        if (file == null || file.isBlank()) {
            Path config = FabricLoader.getInstance().getGameDir().resolve("mcc-waypoint-source.txt");
            try {
                if (!Files.isRegularFile(config) || Files.size(config) > 4096) return;
                file = Files.readString(config).strip();
            } catch (IOException error) {
                return;
            }
        }
        if (file != null && !file.isBlank()) {
            try {
                Path source = Path.of(file);
                if (!source.isAbsolute()) {
                    LoggerFactory.getLogger("MCC Waypoints").warn("MCC waypoint source must be an absolute path.");
                    return;
                }
                WaypointHolograms holograms = new WaypointHolograms(source);
                ServerTickEvents.END_SERVER_TICK.register(holograms::tick);
                holograms.registerCommands();
            } catch (InvalidPathException error) {
                return;
            }
        }
    }

    private void tick(MinecraftServer server) {
        if (++ticks < 20) return;
        ticks = 0;
        if (reading != null && reading.isDone()) {
            points = reading.join();
            reading = null;
        }
        if (reading == null) reading = CompletableFuture.supplyAsync(this::read);
        displays.entrySet().removeIf(entry -> {
            Display.TextDisplay entity = entry.getValue();
            if (points.containsValue(entry.getKey()) && !entity.isRemoved()
                    && loaded(server.getLevel(entry.getKey().dimension()), entry.getKey())) return false;
            entity.discard();
            return true;
        });
        for (Waypoint point : points.values()) {
            ServerLevel level = server.getLevel(point.dimension());
            if (!displays.containsKey(point) && loaded(level, point)) spawn(level, point);
        }
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            String id = targets.get(player.getUUID());
            if (id != null) updateGuide(player, id);
        }
    }

    private void registerCommands() {
        CommandRegistrationCallback.EVENT.register((dispatcher, registry, environment) ->
                registerWaypointCommand(dispatcher));
    }

    private void registerWaypointCommand(CommandDispatcher<CommandSourceStack> dispatcher) {
        dispatcher.register(Commands.literal("mccwaypoint")
                .requires(source -> source.getEntity() instanceof ServerPlayer)
                .executes(context -> list(context.getSource().getPlayerOrException(), 1))
                .then(Commands.literal("list")
                    .executes(context -> list(context.getSource().getPlayerOrException(), 1))
                    .then(Commands.argument("page", IntegerArgumentType.integer(1))
                        .executes(context -> list(context.getSource().getPlayerOrException(), IntegerArgumentType.getInteger(context, "page")))))
                .then(Commands.literal("track").then(Commands.argument("id", StringArgumentType.word())
                    .executes(context -> track(context.getSource().getPlayerOrException(), StringArgumentType.getString(context, "id")))))
                .then(Commands.literal("off").executes(context -> {
                    ServerPlayer player = context.getSource().getPlayerOrException();
                    targets.remove(player.getUUID());
                    player.displayClientMessage(Component.empty(), true);
                    player.sendSystemMessage(Component.literal("Prowadzenie wyłączone."));
                    return 1;
                })));
    }

    private int list(ServerPlayer player, int requestedPage) {
        var visible = points.entrySet().stream()
                .filter(entry -> entry.getValue().dimension().equals(player.level().dimension()))
                .sorted(Comparator.<Map.Entry<String, Waypoint>, String>comparing(entry -> entry.getValue().name(), String.CASE_INSENSITIVE_ORDER)
                        .thenComparing(Map.Entry::getKey)).toList();
        if (visible.isEmpty()) {
            player.sendSystemMessage(Component.literal("Brak publicznych waypointów w tym wymiarze."));
            return 1;
        }
        int pages = (visible.size() + PAGE_SIZE - 1) / PAGE_SIZE;
        int page = Math.min(requestedPage, pages);
        var message = Component.literal("Waypointy · " + page + "/" + pages);
        for (var entry : visible.subList((page - 1) * PAGE_SIZE, Math.min(page * PAGE_SIZE, visible.size()))) {
            Waypoint point = entry.getValue();
            message.append(Component.literal("\n[Wybierz] ").withColor(0x86e1e8)
                    .withStyle(style -> style.withClickEvent(new ClickEvent.RunCommand("/mccwaypoint track " + entry.getKey()))))
                    .append(Component.literal(point.name() + " · " + distance(player, point)));
        }
        if (page > 1) message.append(pageLink("Poprzednia", page - 1));
        if (page < pages) message.append(pageLink("Następna", page + 1));
        message.append(Component.literal("\n/mccwaypoint off · wyłącz prowadzenie"));
        player.sendSystemMessage(message);
        return 1;
    }

    private static Component pageLink(String label, int page) {
        return Component.literal(" [" + label + "]").withColor(0x86e1e8)
                .withStyle(style -> style.withClickEvent(new ClickEvent.RunCommand("/mccwaypoint list " + page)));
    }

    private int track(ServerPlayer player, String id) {
        Waypoint point = points.get(id);
        if (point == null || !point.dimension().equals(player.level().dimension())) {
            player.sendSystemMessage(Component.literal("Ten waypoint jest niedostępny w tym wymiarze."));
            return 0;
        }
        targets.put(player.getUUID(), id);
        updateGuide(player, id);
        return 1;
    }

    private void updateGuide(ServerPlayer player, String id) {
        Waypoint point = points.get(id);
        if (point == null) {
            targets.remove(player.getUUID());
            player.displayClientMessage(Component.literal("Waypoint nie jest już publiczny."), true);
            return;
        }
        if (!point.dimension().equals(player.level().dimension())) {
            player.displayClientMessage(Component.literal(point.name() + " · cel w innym wymiarze"), true);
            return;
        }
        double dx = point.x() + 0.5 - player.getX();
        double dz = point.z() + 0.5 - player.getZ();
        double heading = Math.toDegrees(Math.atan2(-dx, dz)) - player.getYRot();
        String arrow = Math.hypot(dx, dz) < 0.5 ? "◆" : DIRECTIONS[Math.floorMod(Math.round(heading / 45), DIRECTIONS.length)];
        player.displayClientMessage(Component.literal(arrow + " ").withColor(0x86e1e8)
                .append(Component.literal(point.name() + " · " + distance(player, point)).withColor(0xffffff)), true);
    }

    private static String distance(ServerPlayer player, Waypoint point) {
        double horizontal = Math.hypot(point.x() + 0.5 - player.getX(), point.z() + 0.5 - player.getZ());
        double blocks = Math.hypot(horizontal, point.y() + 0.5 - player.getY());
        return String.format(Locale.ROOT, "%,d m", Math.round(blocks)).replace(',', ' ');
    }

    private static boolean loaded(ServerLevel level, Waypoint point) {
        return level != null && level.getChunkSource().getChunkNow(point.x() >> 4, point.z() >> 4) != null;
    }

    private Map<String, Waypoint> read() {
        try (var input = Files.newInputStream(file)) {
            byte[] bytes = input.readNBytes(MAX_BYTES + 1);
            if (bytes.length > MAX_BYTES) return Map.of();
            var rows = JsonParser.parseString(new String(bytes, StandardCharsets.UTF_8)).getAsJsonArray();
            if (rows.size() > 100) return Map.of();
            Map<String, Waypoint> next = new HashMap<>();
            for (var row : rows) {
                JsonObject object = row.getAsJsonObject();
                if (!object.has("hologramY")) continue;
                String id = object.get("id").getAsString();
                if (!id.matches("[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}")) continue;
                String name = object.get("name").getAsString().strip();
                String category = object.get("category").getAsString();
                ResourceKey<Level> dimension = switch (object.get("dimension").getAsString()) {
                    case "overworld" -> Level.OVERWORLD;
                    case "nether" -> Level.NETHER;
                    case "end" -> Level.END;
                    default -> null;
                };
                if (dimension == null || name.isEmpty() || name.length() > 60 || name.matches("(?s).*[\\p{C}\\p{Zl}\\p{Zp}].*")) continue;
                int x = integer(object, "x");
                int y = integer(object, "hologramY");
                int z = integer(object, "z");
                int bottom = dimension == Level.OVERWORLD ? -64 : 0;
                int top = dimension == Level.OVERWORLD ? 319 : 255;
                if (x < -30_000_000 || x > 30_000_000 || z < -30_000_000 || z > 30_000_000 || y < bottom || y > top) continue;
                if (!category.equals("point") && !category.equals("base") && !category.equals("farm")) continue;
                next.put(id, new Waypoint(name, category, dimension, x, y, z));
            }
            return Map.copyOf(next);
        } catch (IOException | RuntimeException error) {
            return Map.of();
        }
    }

    private static int integer(JsonObject object, String key) {
        var value = object.getAsJsonPrimitive(key);
        if (!value.isNumber()) throw new IllegalArgumentException("Expected waypoint coordinate");
        return value.getAsBigDecimal().intValueExact();
    }

    private void spawn(ServerLevel level, Waypoint point) {
        String category = switch (point.category()) {
            case "base" -> "BAZA";
            case "farm" -> "FARMA";
            default -> "PUNKT";
        };
        CompoundTag tag = new CompoundTag();
        tag.putString("billboard", "center");
        tag.putFloat("view_range", 0.75f);
        tag.store("text", ComponentSerialization.CODEC, NbtOps.INSTANCE,
                Component.literal("◆ " + category).withColor(0x86e1e8).append(Component.literal("\n" + point.name()).withColor(0xffffff)));
        Display.TextDisplay display = new Display.TextDisplay(EntityType.TEXT_DISPLAY, level) {
            @Override public boolean shouldBeSaved() { return false; }
            @Override public boolean save(ValueOutput output) { return false; }
        };
        display.load(TagValueInput.create(ProblemReporter.DISCARDING, level.registryAccess(), tag));
        display.setPos(point.x() + 0.5, point.y() + 0.5, point.z() + 0.5);
        if (level.addFreshEntity(display)) displays.put(point, display);
    }
}
