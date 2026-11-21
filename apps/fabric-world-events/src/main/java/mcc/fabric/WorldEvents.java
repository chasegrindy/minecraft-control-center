package mcc.fabric;

import java.util.UUID;

import net.fabricmc.api.DedicatedServerModInitializer;
import net.fabricmc.fabric.api.entity.event.v1.ServerEntityWorldChangeEvents;
import net.fabricmc.fabric.api.entity.event.v1.ServerLivingEntityEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.level.Level;

public final class WorldEvents implements DedicatedServerModInitializer {
    @Override
    public void onInitializeServer() {
        WaypointHolograms.register();
        EventJournal journal = new EventJournal(FabricLoader.getInstance().getGameDir().resolve("mcc-events"));
        ServerLifecycleEvents.SERVER_STARTED.register(server -> journal.start());
        ServerLifecycleEvents.SERVER_STOPPED.register(server -> journal.close());
        ServerEntityWorldChangeEvents.AFTER_PLAYER_CHANGE_WORLD.register((player, origin, destination) -> {
            String from = dimension(origin.dimension());
            String to = dimension(destination.dimension());
            if (from != null && to != null && !from.equals(to)) {
                journal.offer(event("dimension", player, player, to, from, null));
            }
        });
        ServerLivingEntityEvents.AFTER_DEATH.register((entity, damage) -> {
            String world = dimension(entity.level().dimension());
            if (world == null) return;
            if (entity instanceof ServerPlayer player) {
                journal.offer(event("death", player, player, world, null, null));
            } else if (entity.getType() == EntityType.WITHER && damage.getEntity() instanceof ServerPlayer killer) {
                journal.offer(event("boss", killer, entity, world, null, "wither"));
            }
        });
    }

    private static String dimension(ResourceKey<Level> key) {
        if (key.equals(Level.OVERWORLD)) return "overworld";
        if (key.equals(Level.NETHER)) return "nether";
        if (key.equals(Level.END)) return "end";
        return null;
    }

    private static EventJournal.WorldEvent event(String type, ServerPlayer player, Entity entity, String world, String from, String boss) {
        BlockPos pos = entity.blockPosition();
        return new EventJournal.WorldEvent(1, UUID.randomUUID().toString(), System.currentTimeMillis(), type,
                player.getGameProfile().name(), player.getUUID().toString(),
                new EventJournal.Location(world, pos.getX(), pos.getY(), pos.getZ()), from, boss);
    }
}
