package mcc.fabric;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import com.google.gson.Gson;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

final class EventJournal {
    private static final Logger LOGGER = LoggerFactory.getLogger("MCC World Events");
    private static final Gson JSON = new Gson();
    private static final int FILE_LIMIT = 256 * 1024;

    private final Path directory;
    private final Path current;
    private final Path previous;
    private final AtomicBoolean queueWarning = new AtomicBoolean();
    private final ThreadPoolExecutor writer = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(256), task -> {
                Thread thread = new Thread(task, "MCC world event journal");
                thread.setDaemon(true);
                return thread;
            });
    private boolean failed;

    EventJournal(Path directory) {
        this.directory = directory;
        current = directory.resolve("events.jsonl");
        previous = directory.resolve("events.previous.jsonl");
    }

    void start() {
        submit(null);
    }

    void offer(WorldEvent event) {
        submit(event);
    }

    private void submit(WorldEvent event) {
        try {
            writer.execute(() -> {
                queueWarning.set(false);
                try {
                    append(event);
                    failed = false;
                } catch (IOException error) {
                    if (!failed) LOGGER.warn("MCC world event journal unavailable ({})", error.getClass().getSimpleName());
                    failed = true;
                }
            });
        } catch (RejectedExecutionException ignored) {
            if (queueWarning.compareAndSet(false, true)) LOGGER.warn("MCC world event journal queue is full or closed");
        }
    }

    private void append(WorldEvent event) throws IOException {
        if (Files.isSymbolicLink(directory)) throw new IOException("Journal directory must be local");
        Files.createDirectories(directory);
        ensureFile();
        if (event == null) return;
        byte[] bytes = (JSON.toJson(event) + "\n").getBytes(StandardCharsets.UTF_8);
        long size = Files.size(current);
        if (size + bytes.length + 1 > FILE_LIMIT) {
            try {
                Files.move(current, previous, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException ignored) {
                Files.move(current, previous, StandardCopyOption.REPLACE_EXISTING);
            }
            ensureFile();
        } else if (size > 0 && !endsInNewline(size)) {
            Files.write(current, new byte[] { '\n' }, StandardOpenOption.APPEND, LinkOption.NOFOLLOW_LINKS);
        }
        Files.write(current, bytes, StandardOpenOption.APPEND, LinkOption.NOFOLLOW_LINKS);
    }

    private boolean endsInNewline(long size) throws IOException {
        try (SeekableByteChannel file = Files.newByteChannel(current, Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS))) {
            ByteBuffer tail = ByteBuffer.allocate(1);
            file.position(size - 1);
            return file.read(tail) == 1 && tail.get(0) == '\n';
        }
    }

    private void ensureFile() throws IOException {
        if (!Files.exists(current, LinkOption.NOFOLLOW_LINKS)) {
            if (Files.getFileStore(directory).supportsFileAttributeView("posix")) {
                Files.createFile(current, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-r-----")));
            } else {
                Files.createFile(current);
            }
        }
        if (!Files.isRegularFile(current, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Invalid journal file");
    }

    void close() {
        writer.shutdown();
        try {
            if (!writer.awaitTermination(2, TimeUnit.SECONDS)) writer.shutdownNow();
        } catch (InterruptedException interrupted) {
            writer.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }

    record WorldEvent(int v, String id, long time, String type, String player, String uuid, Location location,
            String fromDimension, String boss) {}

    record Location(String dimension, int x, int y, int z) {}
}
