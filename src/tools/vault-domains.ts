export interface VaultDomain {
  id: number;
  key: string;
  name: string;
  shardFile: string;
  keywords: string[];
  topics: string[];
  failures: string[];
  fixes: string[];
}

export const ENVIRONMENTS: string[] = [
  'Bare-Metal High-Frequency x86_64 Dual-Socket NUMA Node',
  'ARM64 Apple Silicon Unified Memory Architecture',
  'NVIDIA H100 Hopper SXM5 with 80GB HBM3 and TMA',
  'Android 15 Mobile ARMv9 with big.LITTLE CPU Governor',
  'Kubernetes MicroVM Pod with cgroup v2 Memory Hard Limits',
  'Multi-Region Geo-Distributed Cluster with 100ms WAN RTT',
  'Low-Power Edge IoT Device with 256MB RAM and Wear-Leveling Flash',
  'Air-Gapped Hardware Security Module (HSM) Enclave',
  'WebAssembly Runtime inside V8 with Thread Proposal Enabled',
  'Bare-Metal DPDK Low-Latency Financial Gateway',
  'AWS Graviton3 C7g Instance with NVMe Nitro SSD',
  'High-End PC Rig with AMD Ryzen 9 5950X and PCIe 4.0 NVMe'
];

export const ARCHITECTURAL_PATTERNS: string[] = [
  'Lock-Free Ring Buffer with Acquire-Release Memory Barriers',
  'Epoch-Based Memory Reclamation with HazPtr Retire Queues',
  'Copy-On-Write Virtual Page Table Slot Mapping',
  'Adaptive Bounded Batching with Microsecond Debounce Jitter',
  'Vectorized SIMD Instruction Dispatch with AVX-512 Fallback',
  'Asynchronous Pipelined Streaming with Backpressure Flow Control',
  'Two-Phase Joint Consensus with Pre-Vote Validation Phase',
  'Zero-Copy Memory-Mapped Buffer Ring with Direct Kernel Submission',
  'Dynamic Scale Normalization with Outlier Feature Clipping',
  'Formal State Machine Invariant Verification with Property Testing',
  'Decoupled Control-Data Planes with Hazard-Free Pointer Swapping',
  'Hierarchical Write-Ahead Log Partitioning with Group Commit'
];

export const VAULT_DOMAINS: VaultDomain[] = [
  {
    id: 0,
    key: 'sys_rust',
    name: 'Systems:Rust',
    shardFile: 'shard_00_sys_rust.sqlite',
    keywords: ['rust', 'pin', 'atomic', 'tokio', 'crossbeam', 'unsafe', 'lifetimes', 'miri', 'simd', 'borrow', 'arc', 'mutex'],
    topics: [
      'Hazard Pointers Memory Reclamation', 'Crossbeam MPMC Channels', 'Atomic Ordering Acquire-Release',
      'Pinning and Unpin Structural Subtyping', 'Lock-free Treiber Stack', 'SIMD Intrinsics AVX-512 Vectorization',
      'Custom Bump Arena Allocator', 'Zero-Copy Slice Deserialization', 'Send-Sync Trait Invariants', 'Tokio Cooperative Task Yielding'
    ],
    failures: [
      'data race on relaxed atomic store', 'cyclic reference memory leak in Arc-Mutex graph',
      'L1 cacheline false sharing during concurrent CAS', 'ABA hazard in lock-free pointer reuse',
      'SIGSEGV from invalid pointer provenance in unsafe block', 'async task starvation under CPU-bound spinloop',
      'unaligned SIMD load causing hardware trap', 'memory fragmentation in glibc default allocator',
      'thread deadlocks from inconsistent lock acquisition order', 'channel buffer overflow under producer backpressure burst'
    ],
    fixes: [
      'enforce strict acquire-release memory fences on shared atomics',
      'implement epoch-based garbage collection with HazPtr retire queue',
      'align shared atomic variables to 64-byte cache line boundaries using #[repr(align(64))]',
      'introduce tagged pointer generation counter to prevent ABA mutation',
      'replace raw pointers with NonNull and validate provenance with Miri assertions',
      'insert tokio::task::yield_now() checkpoints in compute-intensive loops',
      'use _mm512_loadu_si512 unaligned load intrinsics with runtime CPU feature dispatch',
      'switch global memory allocator to jemalloc or mimalloc with background purge',
      'order lock acquisitions via monotonic hierarchy rank comparator',
      'apply bounded backpressure channels with exponential backoff and jitter'
    ]
  },
  {
    id: 1,
    key: 'sys_ebpf',
    name: 'Systems:eBPF',
    shardFile: 'shard_01_sys_ebpf.sqlite',
    keywords: ['ebpf', 'xdp', 'bpf', 'ringbuf', 'kprobe', 'tracepoint', 'cgroup', 'verifier', 'co-re', 'tc', 'btf'],
    topics: [
      'XDP High-Speed Packet Filtering', 'BPF Ring Buffer Event Telemetry', 'Kernel Tracepoint Dynamic Probing',
      'BPF Map Concurrency with Spinlocks', 'Verifier Complexity Optimization', 'eBPF Tail Calls Program Chaining',
      'Socket Filter Load Balancing', 'cgroup Skb Packet Egress Shaping', 'LSM Security Policy Enforcement', 'CO-RE BTF Relocations'
    ],
    failures: [
      'packet drops in XDP generic driver mode', 'ringbuf event drops under telemetry burst',
      'kernel verifier rejection due to unbounded loop', 'race condition on per-CPU map aggregation',
      'stack space overflow beyond 512-byte limit', 'broken tail call jump table lookup',
      'packet corruption from incorrect packet headroom adjustment', 'BPF program detachment upon user daemon crash',
      'BTF type mismatch across kernel minor versions', 'excessive lock contention on shared hash map'
    ],
    fixes: [
      'migrate XDP program from generic to native driver / offloaded mode',
      'tune bpf_ringbuf reserve size and implement adaptive sampling drop rate',
      'replace dynamic loop with bounded pragma unroll and explicit index masks',
      'use bpf_spin_lock or migrate to per-cpu array maps for zero-lock updates',
      'allocate temporary state in BPF per-CPU scratchpad map instead of stack',
      'verify prog_array map index limits and validate program type compatibility',
      'invoke bpf_xdp_adjust_head with 64-byte alignment verification',
      'pin BPF links to /sys/fs/bpf filesystem for persistent lifecycle survival',
      'compile with clang -target bpf -g -O2 and enable BPF CO-RE vmlinux.h relocations',
      'partition high-frequency counters across BPF_MAP_TYPE_PERCPU_HASH'
    ]
  },
  {
    id: 2,
    key: 'sys_io_uring',
    name: 'Systems:io_uring',
    shardFile: 'shard_02_sys_io_uring.sqlite',
    keywords: ['io_uring', 'uring', 'sqpoll', 'cqe', 'sqe', 'asynchronous', 'kernel', 'direct_io', 'registered_buffers'],
    topics: [
      'SQPOLL Kernel Submission Threading', 'Registered Buffer Zero-Copy Read', 'Fixed File Descriptor Tables',
      'Linked Requests Pipeline Execution', 'Fast Poll Network Socket Async IO', 'Direct Write NVMe Submissions',
      'Buffer Ring Allocation (IORING_REGISTER_PBUF_RING)', 'Kernel CQE Overflow Protection', 'Cooperative Polling Event Loop', 'Multishot Accept Sockets'
    ],
    failures: [
      'submission queue stall due to SQPOLL thread sleep timeout', 'memory pinned pages exhaustion during buffer registration',
      'stale file descriptor reference in fixed table', 'broken request chain execution upon intermediate error',
      'high CQE overflow drop rate during network burst', 'CPU core contention between application thread and SQPOLL',
      'page fault stall on non-registered user space buffers', 'use-after-free on completion queue user_data token',
      'kernel deadlocks with asynchronous direct IO write locks', 'file lease expiration during registered fd operations'
    ],
    fixes: [
      'tune sq_thread_idle timeout and bind SQPOLL thread to isolated CPU core via affinity mask',
      'raise RLIMIT_MEMLOCK to allow pre-pinning of persistent IO memory buffers',
      'track fixed fd lifecycle with atomic generation counter and explicit IORING_REGISTER_FILES_UPDATE',
      'attach IOSQE_IO_HARDLINK flag to halt pipeline immediately upon prerequisite failure',
      'configure IORING_SETUP_CQSIZE with 4x submission queue depth and enable CQE backpressure',
      'isolate SQPOLL kernel thread using isolcpus and isolcpus=managed boot flags',
      'pre-register ring buffers via io_uring_register_buf_ring for zero-copy kernel reception',
      'encode slab allocation index and generation tag into 64-bit user_data field',
      'use O_DIRECT | O_NONBLOCK flags and ensure 4096-byte sector alignment',
      'enable multishot accept flag IORING_ACCEPT_MULTISHOT to amortize system call overhead'
    ]
  },
  {
    id: 3,
    key: 'sys_linux_kernel',
    name: 'Systems:Linux_Kernel',
    shardFile: 'shard_03_sys_linux_kernel.sqlite',
    keywords: ['kernel', 'vfs', 'slab', 'slub', 'numa', 'thp', 'page_fault', 'cgroup', 'futex', 'hugepages'],
    topics: [
      'SLUB Memory Allocator Fragmentation', 'Transparent Huge Pages (THP) Defrag Latency', 'NUMA Memory Node Interleaving',
      'Futex Contention & Priority Inversion', 'VFS Dentry Cache Thrashing', 'cgroup v2 PSI (Pressure Stall Information)',
      'Direct I/O Memory Alignment Bounds', 'Page Cache Eviction Pressure', 'Kernel RCU Read-Side Critical Sections', 'Interrupt Thread CPU Affinity'
    ],
    failures: [
      'latency spike during synchronous THP memory compaction', 'slab allocator cache bloat exhausting low memory zones',
      'cross-socket NUMA bus saturation from unbalanced memory node allocation', 'priority inversion deadlocks on unpipelined futex queues',
      'dentry cache evictions degrading filesystem path resolution', 'memory thrashing when hitting cgroup memory.high throttle',
      'unaligned DMA transfers falling back to synchronous bounce buffers', 'dirty page flush storms starving real-time thread I/O',
      'RCU stalls triggered by preemption disabled in lengthy drivers', 'IRQ interrupt storms on CPU 0 causing soft lockups'
    ],
    fixes: [
      'set transparent_hugepage=madvise and pre-allocate explicit 2MB HugeTLB pages',
      'tune slab cache shrinker thresholds and enable memory slab de-fragmentation',
      'apply numactl --interleave=all or bind process memory strictly to local NUMA node',
      'employ PI-futex (FUTEX_LOCK_PI) to propagate priority inheritance under contention',
      'tune vfs_cache_pressure to 50 to preserve hot dentry and inode cache structures',
      'monitor PSI metrics (some, full) and apply cooperative backpressure before memory.kill',
      'enforce posix_memalign with 4096-byte alignment matching NVMe block bounds',
      'tune vm.dirty_background_ratio to 5 and vm.dirty_ratio to 10 for smooth background flushing',
      'insert cond_resched() checkpoints inside extensive kernel loops to yield RCU grace periods',
      'distribute hardware interrupts across physical CPU cores via irqbalance and smp_affinity masks'
    ]
  },
  {
    id: 4,
    key: 'dist_raft',
    name: 'Distributed:Raft',
    shardFile: 'shard_04_dist_raft.sqlite',
    keywords: ['raft', 'consensus', 'leader', 'election', 'quorum', 'log_replication', 'pre_vote', 'joint_consensus', 'linearizable'],
    topics: [
      'Pre-Vote Disruption Mitigation', 'Snapshot Compaction Streaming', 'Joint Consensus Cluster Migration',
      'Linearizable Lease ReadIndex', 'Randomized Heartbeat Jitter', 'Pipelined Log Append RPCs',
      'Learner Non-Voting Node Replicas', 'Witness Quorum Nodes', 'Split-Brain Anti-Affinity', 'Log Truncation Invariants'
    ],
    failures: [
      'split vote livelock during network partition reconnection', 'disk IO saturation during multi-gigabyte snapshot transfer',
      'split-brain configuration during cluster membership change', 'stale reads served by deposed leader after partition',
      'cascading re-elections triggered by synchronous disk flushes', 'head-of-line blocking in sequential log replication',
      'learner node catching up blocks quorum progress', 'witness node vote desynchronization during failover',
      'unrecoverable log index gap after partial disk sync failure', 'heartbeat starvation under high log replication load'
    ],
    fixes: [
      'enable Raft Pre-Vote protocol phase before incrementing node term',
      'stream log snapshots in chunked rate-limited background threads via SSTable hardlinks',
      'execute two-phase Joint Consensus membership transition (C_old,new -> C_new)',
      'implement ReadIndex linearizability with quorum roundtrip heartbeat verification',
      'apply randomized election timeout between 150ms and 300ms with Gaussian jitter',
      'pipeline append log entries RPCs asynchronously with sliding window flow control',
      'isolate learner replication streams from consensus commit calculation pipeline',
      'assign zero weight to witness nodes in data replication quorum while keeping voting power',
      'enforce atomic fsync on WAL commit before replying success to follower append RPC',
      'separate consensus heartbeat messages onto dedicated high-priority network socket'
    ]
  },
  {
    id: 5,
    key: 'dist_paxos',
    name: 'Distributed:Paxos',
    shardFile: 'shard_05_dist_paxos.sqlite',
    keywords: ['paxos', 'multi_paxos', 'proposer', 'acceptor', 'ballot', 'consensus', 'quorum', 'spanner', 'chubby'],
    topics: [
      'Multi-Paxos Master Lease Renewal', 'Phase 1 Ballot Number Collision Resolution', 'Egalitarian Paxos (EPaxos) Dependency Graphs',
      'Fast Paxos Classic vs Fast Quorum Sizes', 'Flexible Paxos Asymmetric Quorum Intersection', 'Diskless Acceptor In-Memory Quorums',
      'State Machine Catch-Up via Gap Filling', 'Byzantine Fault Tolerant Paxos Extensions', 'Hierarchical Paxos Across WAN Zones', 'Reconfiguration Ballot Invariants'
    ],
    failures: [
      'dueling proposers live-lock repeatedly overriding ballot numbers', 'acceptor disk write latency degrading phase 2 commit latency',
      'unresolved dependency cycle in EPaxos concurrent command execution', 'fast quorum collision forcing expensive two-phase fallbacks',
      'split-brain caused by overlapping phase 1 and phase 2 quorum misconfiguration in FlexPaxos',
      'proposer stall waiting for delayed acceptors during WAN spike', 'memory blowup from untruncated instance slots in multi-paxos log',
      'acceptor state desynchronization on silent hardware bit-flip', 'lease expiration gap causing temporary read unavailability',
      'cascade of reconfiguration ballots causing cluster stall'
    ],
    fixes: [
      'elect stable leader proposer with randomized backoff on ballot preemption',
      'pipeline Phase 2 accept messages with group-committed NVMe WAL writes',
      'apply topological sort with Tarjan strongly connected components to resolve EPaxos cycles',
      'configure classic quorum Q1 + fast quorum Q2 > N and Q1 + Q1 > N to guarantee safety',
      'verify asymmetric quorum intersection: every phase 1 quorum must intersect every phase 2 quorum',
      'implement dynamic windowed sliding state machine checkpointing to purge executed Paxos slots',
      'forward read requests to leader with synchronized TrueTime or physical lease guards',
      'execute Phase 1b gap-filling RPCs in background learner threads',
      'deploy 3-phase commit failover for cluster membership reconfiguration',
      'utilize CRC64 checksums and atomic multi-file manifest commits for acceptor logs'
    ]
  },
  {
    id: 6,
    key: 'dist_lsm',
    name: 'Distributed:LSM',
    shardFile: 'shard_06_dist_lsm.sqlite',
    keywords: ['lsm', 'sstable', 'compaction', 'memtable', 'rocksdb', 'bloom_filter', 'leveldb', 'write_amplification', 'wal'],
    topics: [
      'Leveled Compaction Write Amplification', 'Bloom Filter False Positive Rate Tuning', 'Block Cache Eviction Policies',
      'MemTable SkipList Concurrency', 'Write-Ahead Log (WAL) Flush Durability', 'SSTable Block Index Compression',
      'Prefix Bloom Filter Range Scans', 'Tombstone Saturation GC', 'Tiered Storage Cold Tier Offload', 'Dynamic Compaction Priority'
    ],
    failures: [
      'write stalls caused by backlog in L0-to-L1 compaction', 'excessive point read latency due to degraded Bloom filter precision',
      'block cache thrashing during sequential full table scan', 'memory allocation spikes in concurrent skiplist insertions',
      'data loss on power outage due to buffered WAL fsync delay', 'CPU spikes from decompressing unindexed SSTable blocks',
      'pointless disk reads across tombstone-dense key intervals', 'storage volume exhaustion from delayed compaction cleanup',
      'cold tier S3 latency affecting primary read pipeline', 'disk bandwidth saturation starving foreground user queries'
    ],
    fixes: [
      'dynamically throttle ingestion write rate and increase concurrent L0 compaction threads',
      'tune Bloom filter bits-per-key to 10-12 bits and deploy blocked Bloom filters (Ribbon filter)',
      'use 2-Queue (2Q) or TinyLFU block cache policy and bypass cache for bulk table scans',
      'replace standard skiplist with concurrent lock-free flat-combining memtable',
      'configure WAL sync mode to group commit with microsecond batching window',
      'compress SSTable data blocks using Zstandard (Zstd) level 3 with dictionary training',
      'implement compaction tombstone garbage collection threshold and range deletion markers',
      'offload immutable SSTables older than 7 days to cloud object storage via Parquet translation',
      'separate foreground IO priority from background compaction using IO nice (cgroup blkio)',
      'enable prefix seek with dedicated prefix Bloom filter to accelerate range scans'
    ]
  },
  {
    id: 7,
    key: 'dist_b_epsilon',
    name: 'Distributed:B_Epsilon',
    shardFile: 'shard_07_dist_b_epsilon.sqlite',
    keywords: ['b_epsilon', 'fractal_tree', 'betree', 'write_amplification', 'cache_oblivious', 'buffer_tree', 'storage_engine'],
    topics: [
      'Node Buffer Flushes and Cascading Splits', 'Cache-Oblivious B-Tree Memory Layouts', 'Write-Optimized Key Range Buffering',
      'Message Routing Down Internal Node Buffers', 'Pivot Selection under Skewed Key Distribution', 'Garbage Collection of Superseded Node Messages',
      'Concurrent Node Reader-Writer Locks', 'Asynchronous Leaf Node Writebacks', 'Direct Block Compression on Packed Arrays', 'Fast Point Query Path Traversals'
    ],
    failures: [
      'buffer overflow cascading through entire tree hierarchy', 'point query amplification when scanning intermediate node message queues',
      'memory footprint ballooning due to buffered uncommitted updates', 'lock contention on root node during sustained high-throughput bursts',
      'high write latency when node split requires synchronous parent update', 'read amplification in small point queries bypassing node cache',
      'fragmentation of internal node buffers after frequent small message flushes', 'unbalanced tree depth resulting from monotonic key insertions',
      'uncoalesced message buffers wasting disk bandwidth during checkpointing', 'I/O thread starvation during recursive multi-node splits'
    ],
    fixes: [
      'flush messages in bounded bulk batches only when node buffer fills beyond high-water mark',
      'employ fractional cascading to accelerate point query lookups down the node chain',
      'compact and deduplicate messages within node buffers before spilling downward',
      'use hand-over-hand optimistic locking (crabbing) to decouple parent-child node locks',
      'pre-split node when occupancy reaches 90% during downward message traversal',
      'store Bloom filters at each node buffer to skip searching message queues on point queries',
      'pack node messages into contiguous arenas using flat memory layouts',
      'apply randomized pivot perturbation to smooth skewed insertion profiles',
      'coalesce leaf writebacks via background asynchronous worker ring',
      'tune epsilon parameter to balance write-optimization versus point-query read amplification'
    ]
  },
  {
    id: 8,
    key: 'dist_tx',
    name: 'Distributed:Transactions',
    shardFile: 'shard_08_dist_tx.sqlite',
    keywords: ['transaction', 'percolator', '2pc', 'two_phase_commit', 'ssi', 'mvcc', 'tso', 'deadlock', 'write_skew', 'isolation'],
    topics: [
      'Percolator Two-Phase Commit', 'Timestamp Oracle (TSO) Clock Drift', 'Serializable Snapshot Isolation (SSI)',
      'Distributed Deadlock Detection', 'Write-Skew Anomaly Prevention', 'Multi-Version Concurrency Control (MVCC)',
      'Pessimistic vs Optimistic Locking', 'Calvin Deterministic Scheduling', 'Raft-Embedded State Machine Transactions', 'Compensating Saga Workflows'
    ],
    failures: [
      'orphaned primary lock blocking row access after coordinator crash', 'clock skew causing non-linearizable transaction commit order',
      'write-skew anomaly permitted under basic snapshot isolation', 'distributed deadlock cycles between cross-shard coordinators',
      'excessive rollback rate in optimistic concurrency under hot spot write contention',
      'MVCC version chain bloat degrading sequential scan performance',
      'lock escalation exhausting server transaction manager memory', 'TSO network bottleneck limiting global throughput',
      'partial saga failure leaving external third-party systems in inconsistent state', 'transaction timeout cascades under heavy WAN latency'
    ],
    fixes: [
      'implement automated lock cleanup crawler using asynchronous rollback on expired lock leases',
      'deploy TrueTime API or centralized high-availability Timestamp Oracle (TSO) with Raft replication',
      'track dangerous read-write dependency edges (rw-antidependencies) to enforce SSI validation',
      'build distributed wait-for graph with edge forwarding or wound-wait deadlock prevention',
      'switch hot spot rows to pessimistic row locks with queuing to eliminate optimistic abort storms',
      'schedule continuous background MVCC vacuum cleaner to prune obsolete row versions',
      'decouple transaction coordinator into stateful actor with deterministic Raft WAL logging',
      'batch TSO timestamp requests into single atomic vector allocations per millisecond',
      'orchestrate compensating transactions with idempotent replay tokens and dead letter queues',
      'implement adaptive transaction timeouts based on dynamic exponential moving average P99 latency'
    ]
  },
  {
    id: 9,
    key: 'dist_crdt',
    name: 'Distributed:CRDT',
    shardFile: 'shard_09_dist_crdt.sqlite',
    keywords: ['crdt', 'eventual_consistency', 'lww', 'pn_counter', 'or_set', 'yjs', 'automerge', 'state_based', 'delta_crdt', 'causality'],
    topics: [
      'State-Based vs Operation-Based CRDTs', 'Delta-State CRDT Synchronization', 'Lamport Timestamps & Vector Clocks',
      'Observed-Remove Set (ORSet) Tombstones', 'LWW-Element-Set Tie Breaking', 'RGA (Replicated Growable Array) Text Collaboration',
      'Fugue / Eg-walker Text Editing Invariants', 'Causal Broadcast with Message Buffering', 'CRDT Garbage Collection of Obsolete Vectors', 'Peer-to-Peer Anti-Entropy Gossiping'
    ],
    failures: [
      'interleaving anomaly when two concurrent typing operations desynchronize text positions',
      'tombstone memory bloat in deleted items degrading traversal performance',
      'vector clock size explosion with millions of ephemeral transient clients',
      'silent data loss caused by clock skew in Last-Write-Wins (LWW) conflict resolution',
      'delta synchronization packet drops causing missing causal dependencies',
      'CPU spikes during state lattice join operation over large datasets',
      'out-of-order operation arrival violating causal broadcast preconditions',
      'infinite gossip loops in non-idempotent anti-entropy replication',
      'cyclic references when merging concurrent tree node moves',
      'high bandwidth overhead transmitting full state instead of minimal deltas'
    ],
    fixes: [
      'adopt Fugue or RGA algorithm ensuring deterministic non-interleaving character tree ordering',
      'implement epoch-based tombstone compaction once all active replicas acknowledge causal frontier',
      'prune vector clocks with dotted version vectors and client ID mapping tables',
      'pair LWW timestamps with cryptographic replica ID tie-breakers and monotonic local counters',
      'buffer operations in causal hold queue until prerequisite causal frontier is satisfied',
      'optimize semilattice join via delta-CRDT mutation batches and bitset diffs',
      'enforce Lamport vector clock validation before processing remote message streams',
      'use Scuttlebutt anti-entropy protocol with version vectors to exchange only unseen mutations',
      'employ cycle-detection state validation and parent-pointer rollbacks on concurrent tree moves',
      'stream state updates as compressed delta diffs bounded by peer known vector states'
    ]
  },
  {
    id: 10,
    key: 'ai_paged_attn',
    name: 'AI:PagedAttention',
    shardFile: 'shard_10_ai_paged_attn.sqlite',
    keywords: ['paged_attention', 'vllm', 'kv_cache', 'virtual_memory', 'block_table', 'continuous_batching', 'tokens', 'gpu_memory'],
    topics: [
      'Virtual Memory KV-Cache Paging', 'Dynamic Block Table Allocation', 'Continuous Iteration Batching',
      'Prefix Caching Across Conversational Turns', 'CUDA Memory Pool Fragmentation', 'Sliding Window Attention KV Eviction',
      'Speculative Decoding Draft Cache Sync', 'Tensor Parallelism KV-Cache Sharding', 'Chunked Prefill & Decode Scheduling', 'FP8 KV-Cache Compression'
    ],
    failures: [
      'out-of-memory (OOM) GPU crash during sequence length expansion', 'severe external memory fragmentation in static KV tensor allocation',
      'high TTFT (Time To First Token) during large concurrent batch prefill', 'cache misses for shared system prompts across conversational requests',
      'block table desynchronization between CPU scheduler and GPU runtime', 'KV cache eviction causing catastrophic attention quality degradation',
      'draft model token tree KV state race condition in speculative verification', 'GPU inter-node interconnect saturation during all-to-all KV gather',
      'prefill starvation when serving concurrent long-prompt and short-generation streams', 'numerical underflow and precision loss in FP8 quantized KV cache'
    ],
    fixes: [
      'partition KV-cache into discrete non-contiguous physical blocks managed via virtual page tables',
      'implement dynamic logical-to-physical block mapping with copy-on-write page sharing',
      'schedule requests at fine-grained token iteration steps rather than coarse request boundaries',
      'construct radix-tree prefix index to cache and share common prompt attention prefixes',
      'pre-allocate contiguous CUDA memory arena with custom block allocator to prevent fragmentation',
      'use rolling sliding window buffer for tokens outside local receptive field with sink token retention',
      'synchronize draft model speculative verification state via GPU-side bitmasks and tree indexing',
      'shard KV-cache heads evenly across tensor parallel ranks with zero redundant communication',
      'chunk long prompt prefills into uniform token chunks interleaved with decode steps',
      'apply per-tensor dynamic scale factors and outlier clipping when storing KV tokens in FP8 E4M3'
    ]
  },
  {
    id: 11,
    key: 'ai_flash_attn',
    name: 'AI:FlashAttention',
    shardFile: 'shard_11_ai_flash_attn.sqlite',
    keywords: ['flash_attention', 'flashattention3', 'tiling', 'online_softmax', 'sram', 'hbm', 'tensor_cores', 'hopper', 'tma'],
    topics: [
      'Online Softmax Numerical Rescaling', 'SRAM Tiling of Q, K, V Tensors', 'Asymmetric Block Sizes for Long-Context',
      'Causal Masking Tiled Index Skipping', 'Warp-Specialized Producer-Consumer Pipelines', 'TMA Hardware Direct Memory Copy',
      'Backward Pass Recomputation of Attention Matrix', 'FP8 FlashAttention GEMM Tile Precision', 'Variable-Length Sequences Packing (cu_seqlens)', 'Cross-Attention Memory Optimization'
    ],
    failures: [
      'numerical overflow in un-normalized softmax exponentiation on large sequences', 'SRAM cache capacity thrashing due to excessively large tile dimensions',
      'wasted Tensor Core cycles computing masked out lower-triangular causal blocks', 'register pressure spilling intermediate softmax accumulators to DRAM',
      'pipeline bubbles between TMA memory loads and Tensor Core MMA instructions', 'numerical divergence in backward pass gradient accumulation',
      'memory leaks from allocating padding tokens in variable-length batch sequences', 'underutilization of Hopper asynchronous copy pipeline (wgmma)',
      'HBM memory bandwidth saturation from reloading Q tiles repeatedly', 'inaccurate FP8 matrix multiplication causing attention degradation'
    ],
    fixes: [
      'deploy Milakov-Gimelshein online softmax algorithm to maintain running max and sum accumulators',
      'tile Q into Brx128 and K,V into Bcx128 matching available GPU shared memory limits',
      'skip compute tiles entirely where key indices strictly exceed query indices in causal mode',
      'use warp specialization with separate warps dedicated to memory staging and math execution',
      'orchestrate async transfers with Hopper TMA and hardware mbarrier arrival tracking',
      'recompute intermediate attention scores in backward pass directly from Q, K, V saved in HBM',
      'pack variable-length sequences into single 1D tensor using cu_seqlens prefix sum offsets',
      'interleave WGMMA instructions with software-pipelined shared memory stages',
      'keep Q tile stationary in SRAM while streaming through matching K and V blocks from HBM',
      'maintain softmax scaling accumulator in FP32 while executing GEMMs in FP8 / FP16'
    ]
  },
  {
    id: 12,
    key: 'ai_quant',
    name: 'AI:Quantization',
    shardFile: 'shard_12_ai_quant.sqlite',
    keywords: ['quantization', 'awq', 'gptq', 'fp8', 'smoothquant', 'int4', 'gguf', 'ptq', 'qat', 'moe_quant'],
    topics: [
      'AWQ Activation-Aware Weight Quantization', 'GPTQ Second-Order Hessian Optimization', 'FP8 E4M3 vs E5M2 Scaling Factors',
      'GGUF Block-Quantized Tensor Formats', 'SmoothQuant Outlier Feature Migration', 'INT4 Weight-Only GEMM Kernels',
      'Mixed-Precision MoE Expert Quantization', 'Post-Training Quantization (PTQ) Calibration', 'Per-Channel vs Per-Tensor Scaling', 'Quantization-Aware Fine-Tuning (QAT)'
    ],
    failures: [
      'severe perplexity explosion from quantizing salient attention outlier weights',
      'numerical instability during Hessian matrix inversion in GPTQ calculation',
      'clipping saturation in FP8 E4M3 tensors lacking dynamic scale normalization',
      'dequantization overhead erasing GPU throughput gains in memory-bound batch size 1',
      'systematic activation outlier spikes corrupting matrix multiplications in feed-forward layers',
      'CUDA warp divergence in mixed-precision quantized GEMM kernels',
      'expert collapse in quantized Mixture-of-Experts (MoE) routing gate weights',
      'calibration dataset distribution mismatch causing poor generalization on real prompts',
      'accumulated rounding error in INT4 integer dot products on older GPU architectures',
      'gradient vanishing during fake-quantization backward pass in QAT'
    ],
    fixes: [
      'protect top 1% salient weight channels based on activation magnitudes without quantizing them',
      'apply Cholesky decomposition with diagonal damping regularization to stabilize Hessian inversion',
      'dynamically compute per-token and per-channel scale factors for FP8 E4M3 tensors',
      'fuse dequantization and GEMM operation into unified CUTLASS kernel with shared memory staging',
      'scale activations and inverse-scale weights using per-channel smoothing factors (SmoothQuant)',
      'reorder weight bit-packing to align with 32-bit registers and eliminate warp divergence',
      'keep MoE routing gate and first layer attention projections in FP16 / BF16',
      'generate domain-representative calibration datasets covering long context and structured data',
      'use per-group scaling (e.g. group size 128) to limit error propagation in INT4 quantization',
      'apply Straight-Through Estimator (STE) with learnable step size quantization (LSQ)'
    ]
  },
  {
    id: 13,
    key: 'ai_cuda_gemm',
    name: 'AI:CUDA_GEMM',
    shardFile: 'shard_13_ai_cuda_gemm.sqlite',
    keywords: ['cuda', 'gemm', 'wmma', 'mma', 'shared_memory', 'bank_conflict', 'warp_shuffle', 'cutlass', 'ptx'],
    topics: [
      'FlashAttention Forward Kernel', 'Shared Memory Bank Conflict Mitigation', 'Warp Shuffle Intrinsics (__shfl_sync)',
      'Tensor Core WMMA Tile Alignment', 'Asynchronous Memory Staging (cudaMemcpyAsync)', 'CUDA Graph Execution Replay',
      'CUTLASS Epilogue Fusion', 'Registers Per Thread Pressure & Spill', 'Double Buffering with TMA (Hopper)', 'Occupancy Optimization'
    ],
    failures: [
      'shared memory bank conflict serializing 32-thread memory access across bank lines',
      'warp divergence when branching on non-uniform thread indices in loop tails',
      'register spilling to local memory (DRAM) causing drastic kernel throughput collapse',
      'pipeline stall during synchronous CPU-to-GPU tensor transfers',
      'high launch overhead on small frequent kernel launches in iterative token generation',
      'illegal memory access in TMA (Tensor Memory Accelerator) asynchronous copy',
      'uncoalesced global memory reads across non-consecutive thread addresses',
      'low SM occupancy caused by excessive shared memory allocation per block',
      'numerical drift in warp reduction without proper memory barriers',
      'deadlock in cooperative groups grid synchronization across multi-GPU nodes'
    ],
    fixes: [
      'pad shared memory arrays with 1 element per row to eliminate bank conflicts',
      'restructure algorithms using __shfl_down_sync warp shuffle intrinsics instead of shared memory for reductions',
      'tune launch bounds (__launch_bounds__) and reduce variable live ranges to prevent register spilling',
      'stage memory transfers across multiple concurrent CUDA streams with pinned host memory (cudaMallocHost)',
      'capture iterative decoding sequences into static CUDA Graphs to eliminate CPU driver launch latency',
      'synchronize TMA asynchronous copies using mbarrier.arrive and mbarrier.wait hardware barriers',
      'align global memory loads to 128-byte segments and ensure consecutive threads access consecutive elements',
      'balance block size and shared memory usage to maximize active warps per SM',
      'enforce strict __syncwarp() barriers before consuming values produced by neighboring warp lanes',
      'verify hardware cooperative launch support via cudaOccupancyMaxActiveBlocksPerMultiprocessor'
    ]
  },
  {
    id: 14,
    key: 'ai_triton',
    name: 'AI:Triton_JIT',
    shardFile: 'shard_14_ai_triton.sqlite',
    keywords: ['triton', 'jit', 'tl.load', 'tl.store', 'autotune', 'block_size', 'num_warps', 'compiler', 'gpu_kernel'],
    topics: [
      'Triton Block Pointer (tl.make_block_ptr) Striding', 'Autotuning Search Spaces (triton.autotune)',
      'Shared Memory Allocation via num_stages', 'Warp Dimension Tuning with num_warps', 'Vectorized Masking (boundary checks)',
      'Fusion of Layernorm + GELU Activation', 'Atomic RMW Add Operations (tl.atomic_add)', 'Triton Intermediate Representation (TTIR) Optimization',
      'Cross-Row Reductions (tl.sum / tl.max)', 'Async Copy Pipeline Lowering'
    ],
    failures: [
      'out-of-bounds GPU memory fault on non-power-of-two tensor dimensions', 'autotune cache thrashing re-compiling kernels during dynamic batch sizes',
      'shared memory overflow when selecting high num_stages on older architectures', 'poor memory coalescing from non-contiguous tensor strides',
      'numerical underflow when computing softmax max reduction in FP16', 'GPU core stall caused by atomic serialization on shared counters',
      'compiler optimization failure on complex control flow branches inside Triton kernel', 'register spilling when combining large BLOCK_M and BLOCK_N',
      'inaccurate gradient calculation due to missing masking on backward reduction', 'slow launch latency when compiling thousands of kernel variations'
    ],
    fixes: [
      'use tl.make_block_ptr with explicit boundary_check=(0, 1) and padding_option="zero"',
      'warm up autotuner on canonical shapes and persist compiled binary cache to disk',
      'scale num_stages adaptively based on target GPU architecture shared memory limits',
      'ensure innermost tensor dimension is contiguous or call .contiguous() before kernel launch',
      'cast intermediate values to tl.float32 during row-wise max and sum reductions',
      'replace global atomic additions with threadblock-local shared memory reduction ladders',
      'flatten conditional branches into masked arithmetic operations using tl.where',
      'tune num_warps and reduce BLOCK dimensions to keep registers under 255 per thread',
      'apply accurate mask arrays in both forward and backward pass kernel signatures',
      'deploy precompiled kernel wheels and pin configurations with @triton.heuristics'
    ]
  },
  {
    id: 15,
    key: 'ai_speculative',
    name: 'AI:Speculative_Decoding',
    shardFile: 'shard_15_ai_speculative.sqlite',
    keywords: ['speculative_decoding', 'draft_model', 'target_model', 'verification', 'acceptance_rate', 'medusa', 'eagle', 'tree_attention'],
    topics: [
      'Draft Model Token Tree Generation', 'Target Model Parallel Verification Mask', 'Acceptance Probability Distribution Alignment',
      'Rejection Sampling with Residual Probabilities', 'Medusa Multi-Head Non-Autoregressive Heads', 'EAGLE Feature-Level Speculation',
      'Dynamic Draft Step Count Adaptation', 'KV-Cache Rollback on Rejection', 'Speculative Token Alignment Verification', 'Batched Speculation Scheduler'
    ],
    failures: [
      'speculative throughput regression when acceptance rate drops below 50%', 'target model KV-cache corruption from uncommitted rejected tokens',
      'distributional drift between draft and target model tokenizers', 'GPU kernel launch overhead in small draft verification loops',
      'numerical instability in residual probability sampling after rejection', 'tree attention mask explosion exhausting GPU shared memory',
      'wasted compute verifying deep draft paths when shallow token is rejected', 'thread synchronization stalls between draft worker and target worker',
      'memory allocation churn when rebuilding speculative attention tree masks per step', 'underperforming multi-head prediction on high-entropy tokens'
    ],
    fixes: [
      'implement dynamic draft length controller that throttles draft tokens on low-confidence prompts',
      'isolate draft KV tokens in scratchpad blocks and commit only accepted prefixes to main KV table',
      'verify tokenizer vocabulary parity and logit mapping between draft and target architectures',
      'fuse speculative tree generation and verification into unified batched CUDA kernel',
      'sample rejected replacement tokens strictly from clamp(P_target - P_draft, 0) / sum',
      'prune speculative candidate tree using top-k logit thresholds to constrain mask size',
      'evaluate draft tokens in breadth-first topological order to prune dead subtrees early',
      'run draft generation asynchronously on dedicated GPU streaming multiprocessor partition',
      'pre-allocate reusable static tree-attention buffers indexed by draft tree topologies',
      'train Medusa heads with cross-entropy loss augmented by multi-step consistency regularizers'
    ]
  },
  {
    id: 16,
    key: 'ai_distributed',
    name: 'AI:Distributed_Training',
    shardFile: 'shard_16_ai_distributed.sqlite',
    keywords: ['megatron', 'deepspeed', 'zero', 'pipeline_parallelism', 'tensor_parallelism', 'all_reduce', 'nccl', 'fsdp'],
    topics: [
      'Megatron Tensor Parallelism Column & Row Linear', 'DeepSpeed ZeRO-3 Parameter Partitioning', 'Pipeline Parallelism 1F1B Scheduling',
      'NCCL Ring vs Tree AllReduce Topologies', 'Activation Checkpointing (Gradient Recomputation)', 'Sequence Parallelism LayerNorm Scatter-Gather',
      'Gradient Accumulation with Micro-Batches', 'Inter-Node InfiniBand / RoCE Congestion Control', 'Data Parallelism Gradient Desynchronization', 'Mixture-of-Experts Expert Parallelism'
    ],
    failures: [
      'NCCL collective communication timeout during heavy AllGather across nodes', 'pipeline bubble overhead in naive pipeline parallelism schedules',
      'GPU OOM during backward pass due to unpartitioned optimizer states', 'InfiniBand PFC (Priority Flow Control) deadlock in congested networks',
      'numerical instability in FP16 gradient all-reduce without dynamic loss scaling', 'expert load imbalance causing straggler workers in MoE routing',
      'memory bandwidth saturation from redundant activation rematerialization', 'cross-node synchronization barrier skew from slowest GPU straggler',
      'desynchronization of model weights across DP ranks after corrupted gradient sync', 'inter-GPU NVLink bandwidth throttling due to thermal degradation'
    ],
    fixes: [
      'tune NCCL_BUFFSIZE and set NCCL_IB_TC=106 with adaptive ring/tree topology selection',
      'schedule pipeline execution via One-Forward-One-Backward (1F1B) with interleaved stages',
      'shard model states, gradients, and optimizer parameters across all ranks using ZeRO-3 / FSDP',
      'configure ECN (Explicit Congestion Notification) and DCQCN on RoCE switches to prevent pause frames',
      'adopt BF16 mixed-precision training or robust dynamic loss scaling with gradient clipping',
      'implement auxiliary load-balancing loss and capacity factor routing in MoE gates',
      'selectively checkpoint only memory-intensive attention activations while caching MLP outputs',
      'monitor GPU clock speeds and detect stragglers via automated heartbeat health probes',
      'verify gradient checksums periodically and broadcast master weights from rank 0',
      'enforce proper cooling profiles and balance NVLink routing across all GPU sockets'
    ]
  },
  {
    id: 17,
    key: 'sec_crypto',
    name: 'Security:Cryptography',
    shardFile: 'shard_17_sec_crypto.sqlite',
    keywords: ['crypto', 'chacha20', 'poly1305', 'ml_kem', 'kyber', 'constant_time', 'ed25519', 'side_channel', 'tls', 'hsm'],
    topics: [
      'ChaCha20-Poly1305 Authenticated Encryption', 'Kyber / ML-KEM Post-Quantum Key Encapsulation',
      'Constant-Time BigInt Arithmetic', 'Side-Channel Power & Timing Attack Resistance',
      'Ed25519 Batch Signature Verification', 'Hardware Security Module (HSM) PKCS#11 Interfaces',
      'Zero-Knowledge R1CS Constraint Proofs', 'TLS 1.3 0-RTT Anti-Replay Tokens', 'Secret Key Wiping & Memory Protection', 'Curve25519 Elliptic Curve Diffie-Hellman'
    ],
    failures: [
      'nonce reuse in ChaCha20-Poly1305 destroying authenticity and confidentiality',
      'side-channel timing leak in conditional branching over secret cryptographic keys',
      'decapsulation failure rate vulnerability in non-constant-time lattice polynomial reduction',
      'forged signature acceptance in batch verification without strict subgroup check',
      'memory swap paging leaking plain-text private keys to persistent disk storage',
      'replay attack on 0-RTT early data payload under network MITM eavesdropping',
      'R1CS under-constrained circuit permitting fake zero-knowledge proof generation',
      'PKCS#11 session leak exhausting hardware security module crypto slots',
      'small-subgroup attack on non-clamped Curve25519 scalar multiplications',
      'weak PRNG seed generation from uninitialized entropy pools'
    ],
    fixes: [
      'enforce 96-bit monotonic counter or XChaCha20 192-bit random nonces to guarantee uniqueness',
      'replace secret-dependent branches with constant-time bitwise selection routines (ct_select)',
      'implement centered binomial distribution sampling and constant-time Number Theoretic Transform (NTT)',
      'verify that all public keys and signature points lie strictly on the prime-order subgroup before batch verification',
      'lock sensitive key buffers in RAM using mlock() and overwrite with explicit zeroes (sodium_memzero)',
      'enforce single-use ticket age verification and strikeout tables for TLS 1.3 0-RTT payloads',
      'add formal constraint verification to ensure every intermediate wire in R1CS is uniquely constrained',
      'wrap PKCS#11 sessions in RAII auto-closing handles with global connection pooling',
      'clamp scalar private keys by clearing lower 3 bits and setting highest bits per RFC 7748',
      'seed CSPRNG strictly from OS getrandom(2) / CryptGenRandom with entropy health checks'
    ]
  },
  {
    id: 18,
    key: 'sec_zkp',
    name: 'Security:ZeroKnowledge',
    shardFile: 'shard_18_sec_zkp.sqlite',
    keywords: ['zkp', 'snark', 'stark', 'plonk', 'groth16', 'r1cs', 'polynomial_commitment', 'kzg', 'fri', 'arithmetization'],
    topics: [
      'Groth16 Trusted Setup & Verification', 'PLONK Permutation Argument & Copy Constraints', 'KZG Polynomial Commitments on Elliptic Curves',
      'STARK FRI (Fast Reed-Solomon Interactive Oracle Proofs)', 'R1CS Quadratic Arithmetic Programs (QAP)', 'Non-Interactive Fiat-Shamir Transformation',
      'Recursive SNARK Proof Composition (Halo2)', 'Custom Lookup Gates (Plookup / LogUp)', 'Poseidon Hash Arithmetic Circuits', 'Nullifier Double-Spend Prevention'
    ],
    failures: [
      'under-constrained gate allowing prover to forge valid witness values', 'weak Fiat-Shamir heuristic vulnerable to transcript collision forgery',
      'verifier griefing via unverified pairing computations on malformed elliptic curve points', 'trusted setup toxic waste leak compromising global proof integrity',
      'degree overflow in polynomial multiplication invalidating KZG batch opening', 'hash circuit constraint explosion when using legacy SHA-256 instead of SNARK-friendly hashes',
      'nullifier collision permitting double-spending in privacy mixer', 'memory exhaustion during multi-scalar multiplication (MSM) on large witnesses',
      'recursive proof verification recursion depth exceeding field limits', 'unsoundness from unconstrained intermediate wire assignments'
    ],
    fixes: [
      'audit circuits with formal solvers (e.g. Ecne, Circomspect) to guarantee full wire constraint',
      'absorb all public inputs, commitments, and intermediate values into cryptographic Fiat-Shamir transcript',
      'validate that all incoming points lie strictly on curve G1/G2 before evaluating pairing checks',
      'utilize transparent setup protocols (STARKs / FRI) or universal multi-party ceremonies (Powers-of-Tau)',
      'enforce strict degree bounds and verify polynomial remainder quotient invariants',
      'replace standard bitwise hash functions with algebraic Sponge hashes like Poseidon or Rescue',
      'derive nullifiers deterministically using PRF(secret_key, leaf_index) with collision resistance',
      'accelerate MSMs via Pippenger algorithm implemented on GPU / FPGA hardware accelerators',
      'deploy cycle-of-curves (Pasta curves: Pallas/Vesta) for efficient infinite recursion without emulation',
      'enforce compiler-level static analysis requiring assertions on every intermediate witness variable'
    ]
  },
  {
    id: 19,
    key: 'sec_memory_safety',
    name: 'Security:Memory_Safety',
    shardFile: 'shard_19_sec_memory_safety.sqlite',
    keywords: ['memory_safety', 'aslr', 'cfi', 'mte', 'use_after_free', 'buffer_overflow', 'rop', 'shadow_stack', 'canary'],
    topics: [
      'ARM Memory Tagging Extension (MTE) Hardware Enforcement', 'Clang Control Flow Integrity (CFI)',
      'Intel CET Shadow Stack and Indirect Branch Tracking', 'Address Space Layout Randomization (ASLR) Entropy',
      'Stack Canaries & Frame Pointer Protection', 'Safe Memory Allocator Quarantine Arenas (Hardened Malloc)',
      'Use-After-Free Detection via Page Guard Boundaries', 'Return-Oriented Programming (ROP) Gadget Elimination',
      'Fortify Source Compile-Time Buffer Bounds Verification', 'Capabilities & CHERI Architecture Pointers'
    ],
    failures: [
      'use-after-free vulnerability exploited via heap spraying', 'ROP chain execution hijacking control flow via overwritten return address',
      'stack-based buffer overflow corrupting saved frame pointer', 'ASLR bypass resulting from memory information disclosure leak',
      'type confusion vulnerability allowing arbitrary memory read/write', 'MTE tag mismatch suppressed by synchronous exception masking',
      'double-free leading to corrupted allocator metadata and code execution', 'integer overflow in buffer length check leading to out-of-bounds write',
      'CFI bypass via valid but unintended indirect call target', 'dangling pointer dereference in multi-threaded concurrent deallocation'
    ],
    fixes: [
      'enable ARM MTE synchronous tag check mode to crash instantly on out-of-bounds or use-after-free access',
      'enforce Intel CET hardware shadow stacks and forward-edge Indirect Branch Tracking (IBT)',
      'compile binaries with -fstack-protector-strong -D_FORTIFY_SOURCE=3 and full RELRO',
      'maximize ASLR entropy by compiling with PIE and enabling high-entropy virtual address allocation',
      'deploy hardened memory allocators with randomized metadata, slot randomization, and quarantine queues',
      'use Clang -fsanitize=cfi to enforce forward-edge control flow call graph integrity',
      'replace raw pointer arithmetic with bounds-checked fat pointers or safe container spans',
      'enforce strict compiler overflow intrinsics (__builtin_add_overflow) on all buffer length arithmetic',
      'isolate sensitive heaps using virtual memory page guards (mprotect PROT_NONE)',
      'transition vulnerable C/C++ components to memory-safe languages with compile-time borrow checking'
    ]
  },
  {
    id: 20,
    key: 'sec_formal_verif',
    name: 'Security:Formal_Verification',
    shardFile: 'shard_20_sec_formal_verif.sqlite',
    keywords: ['formal_verification', 'tla+', 'coq', 'lean', 'model_checking', 'invariants', 'smt', 'z3', 'dafny', 'proofs'],
    topics: [
      'TLA+ Specification of Distributed State Machines', 'SMT Solver Bit-Vector Solving with Z3', 'Dafny Verified Function Pre- and Post-Conditions',
      'Coq Interactive Theorem Proving of Cryptographic Primitives', 'Temporal Logic LTL / CTL Safety and Liveness Invariants',
      'Bounded Model Checking (CBMC) for C Code', 'Rust Prusti / Kani Verification Engines', 'Proof-Carrying Code Invariants',
      'Abstract Interpretation Value Range Analysis', 'Refinement Types for Static Invariant Enforcement'
    ],
    failures: [
      'state space explosion stalling model checker verification run', 'liveness violation causing unhandled distributed system deadlock',
      'unsound specification axiom introducing false proof of correctness', 'Z3 solver timeout on non-linear integer arithmetic theory',
      'unhandled edge case resulting from discrepancy between TLA+ spec and real implementation',
      'inductive invariant too weak to prove inductive step', 'silent assumption of integer bounds leading to runtime overflow',
      'temporal logic formula failing to detect subtle starvation scenario', 'inconsistency in axiomatic type classes breaking proof checker soundness',
      'divergence between verified abstract algorithm and actual multi-threaded memory model'
    ],
    fixes: [
      'decompose complex monolithic specifications into modular refinement layers',
      'formulate strong inductive invariants that hold across all state transitions before model checking',
      'use symmetry reduction and state hashing to prune state space in TLC model checker',
      'bound loop unrolling and replace non-linear operations with linear approximation abstractions in SMT',
      'verify source code directly using bounded model checkers (Kani / CBMC) targeting Rust / C ASTs',
      'prove liveness using well-founded ranking functions and fairness constraints (WF_vars / SF_vars)',
      'eliminate unproven axioms and establish foundational proofs strictly from core constructive logic',
      'generate executable code directly from verified models via proven extraction pipelines',
      'combine automated SMT solving with interactive tactic guidance for difficult proof obligations',
      'validate hardware-level memory model semantics explicitly within formal transition systems'
    ]
  },
  {
    id: 21,
    key: 'net_dpdk',
    name: 'Networking:DPDK',
    shardFile: 'shard_21_net_dpdk.sqlite',
    keywords: ['dpdk', 'kernel_bypass', 'pmd', 'mbuf', 'ring', 'hugepages', 'nic', 'packet_processing', 'pcap', 'pcie'],
    topics: [
      'Poll Mode Driver (PMD) Zero-Interrupt Reception', 'Memory Pool (rte_mempool) Hugepage Pre-Allocation',
      'Lock-Free Ring Queues (rte_ring) Multi-Producer Multi-Consumer', 'Receive Side Scaling (RSS) Flow Hashing',
      'Direct PCIe Access via VFIO Driver', 'Hardware NIC Offloads (Checksum, TSO, LRO)', 'Zero-Copy Packet Forwarding Pipelines',
      'NUMA-Aware Memory Socket Pinning', 'Jumbo Frame MTU Buffer Allocation', 'KNI / TAP Kernel Interoperability'
    ],
    failures: [
      'PMD 100% CPU core spinning starving co-located system tasks', 'mbuf pool exhaustion causing immediate hardware packet drops',
      'PCIe bus throughput collapse from cross-NUMA node packet descriptor access', 'broken packet distribution due to asymmetric RSS hashing',
      'kernel kernel crash when VFIO IOMMU mapping fails under heavy DMA', 'head-of-line blocking in unbuffered inter-core rte_ring queues',
      'cache misses from bouncing mbuf headers across different CPU L1/L2 caches', 'corrupted packet transmission when hardware checksum offload flags are omitted',
      'packet reordering in multi-queue parallel worker pipelines', 'NIC TX queue hang caused by unreplenished transmit descriptors'
    ],
    fixes: [
      'isolate DPDK worker cores using kernel boot parameters isolcpus, nohz_full, and rcu_nocbs',
      'size rte_mempool to 2x maximum burst depth and tune per-core cache sizes',
      'allocate memory pools strictly on the local NUMA socket attached to the physical NIC PCIe lane',
      'configure symmetric Toeplitz hash keys to ensure bidirectional network flows land on identical cores',
      'bind devices to vfio-pci with IOMMU enabled to guarantee secure DMA memory protection',
      'use burst packet processing APIs (rte_eth_rx_burst) with standard 32 or 64 packet batches',
      'pre-fetch mbuf packet headers into CPU L1 cache using rte_prefetch0 before inspection',
      'set PKT_TX_IPV4 and PKT_TX_TCP_CKSUM flags explicitly to trigger NIC hardware computation',
      'implement flow-director or consistent hashing on 5-tuple to prevent packet reordering across cores',
      'monitor TX free threshold and invoke rte_eth_tx_done_cleanup periodically to reclaim descriptors'
    ]
  },
  {
    id: 22,
    key: 'net_quic',
    name: 'Networking:QUIC',
    shardFile: 'shard_22_net_quic.sqlite',
    keywords: ['quic', 'http3', 'congestion_control', 'bbr', '0_rtt', 'packet_loss', 'connection_id', 'tls13', 'udp'],
    topics: [
      'Connection ID Migration Across Networks', '0-RTT Handshake Key Derivation and Anti-Replay', 'Stream Multiplexing without Head-of-Line Blocking',
      'BBRv2 / Cubic Congestion Control over UDP', 'Path MTU Discovery (PMTUD) & UDP Fragmentation', 'QUIC Packet Pacing with Kernel SO_TXTIME',
      'Flow Control Window Autosizing (Stream & Connection)', 'Loss Detection & Monotonic Packet Numbering', 'QPACK Header Compression Dynamic Table', 'Egress UDP GSO (Generic Segmentation Offload)'
    ],
    failures: [
      'middlebox UDP rate-limiting or outright packet dropping', '0-RTT replay attack executing duplicate non-idempotent HTTP actions',
      'CPU spikes handling single UDP packets without GSO batching', 'connection stall caused by stream flow control exhaustion',
      'blackhole packet drops when path MTU decreases dynamically', 'connection migration failure during NAT rebinding',
      'buffer bloat under packet loss due to misconfigured congestion window', 'QPACK head-of-line blocking when dynamic table capacity is exceeded',
      'UDP socket buffer overflow under sudden multi-gigabit traffic burst', 'amplification attack vulnerability during unvalidated address handshake'
    ],
    fixes: [
      'enable fallback to TCP / TLS 1.3 when UDP path validation fails repeatedly',
      'restrict 0-RTT payloads strictly to idempotent GET requests and employ replay caches',
      'leverage UDP GSO (sendmsg with UDP_SEGMENT) and GRO to process 64KB aggregated packets',
      'dynamically auto-tune connection and stream receive windows based on Bandwidth-Delay Product (BDP)',
      'implement DPLPMTUD (RFC 8899) probing to discover path MTU without relying on ICMP',
      'issue a pool of connection IDs to client and switch IDs upon detected network path migration',
      'deploy BBRv3 congestion control with accurate pacing to minimize queueing delay and loss',
      'tune QPACK dynamic table size and enforce conservative acknowledge modes',
      'scale kernel SO_RCVBUF and SO_SNDBUF to 16MB+ for high-throughput UDP sockets',
      'enforce anti-amplification limit (3x received bytes) until client IP address is fully validated'
    ]
  },
  {
    id: 23,
    key: 'gfx_webgpu',
    name: 'Graphics:WebGPU',
    shardFile: 'shard_23_gfx_webgpu.sqlite',
    keywords: ['webgpu', 'wgsl', 'compute_shader', 'render_pipeline', 'bind_group', 'uniform_buffer', 'msaa', 'indirect_draw'],
    topics: [
      'WGSL Compute Shader Barrier Synchronization', 'Uniform Buffer 16-Byte Alignment Packing',
      'Bind Group Layout Descriptor Pooling', 'Depth-Stencil Multi-Sample Antialiasing (MSAA)',
      'Indirect Draw Buffer GPU-Driven Rendering', 'Compute-to-Render Pipeline Barriers',
      'Texture Storage Format Conversions', 'Async GPU Buffer Mapping & Readback',
      'Ray Tracing Acceleration Structures (BVH)', 'Pipeline State Object (PSO) Precompilation'
    ],
    failures: [
      'race condition between workgroup threads accessing shared memory in WGSL compute shader',
      'shader compilation failure due to struct field not meeting 16-byte alignment requirement',
      'excessive garbage collection pauses from allocating BindGroupLayout descriptors per frame',
      'visual artifacting during depth resolve on multi-sampled render targets',
      'GPU hang caused by out-of-bounds index access in indirect draw call buffers',
      'read-after-write hazard when render pipeline reads texture updated by prior compute pass',
      'CPU main-thread stutter during synchronous mapAsync buffer readbacks',
      'format validation error binding rgba8unorm texture to storage write view',
      'excessive memory allocation during dynamic BVH traversal stack allocation',
      'jank on first frame rendering from synchronous createRenderPipeline compilation'
    ],
    fixes: [
      'insert workgroupBarrier() and storageBarrier() before reading shared workgroup arrays',
      'annotate WGSL struct members with @align(16) and @size(16) or pad variables to 16 bytes',
      'cache and reuse BindGroup and BindGroupLayout instances across render passes',
      'configure depthStoreOp as store and specify resolveTarget for multi-sample depth resolve',
      'validate indirect draw arguments inside compute shader before writing to indirect buffer',
      'encode compute and render passes into single command encoder with implicit subpass dependencies',
      'use staging buffer with mapAsync in dedicated worker thread to decouple CPU readback from rendering',
      'declare texture with rgba8unorm storage format or use rgba32float for general compute storage',
      'implement fixed-depth short-stack BVH traversal algorithm suitable for GPU registers',
      'precompile all render and compute pipelines asynchronously during initialization using createRenderPipelineAsync'
    ]
  },
  {
    id: 24,
    key: 'gfx_vulkan',
    name: 'Graphics:Vulkan',
    shardFile: 'shard_24_gfx_vulkan.sqlite',
    keywords: ['vulkan', 'spir_v', 'pipeline_barrier', 'semaphore', 'command_buffer', 'render_pass', 'swapchain', 'ray_tracing', 'memory_allocation'],
    topics: [
      'Pipeline Barrier & Memory Hazard Synchronization', 'Timeline Semaphores Multi-Queue Coordination',
      'Vulkan Memory Allocator (VMA) Sub-Allocation', 'Swapchain Acquisition & Presentation Synchronization',
      'Descriptor Indexing & Bindless Textures', 'Hardware Ray Tracing Pipeline (VK_KHR_ray_tracing)',
      'Subpass Self-Dependencies for Deferred Rendering', 'Dynamic Rendering (VK_KHR_dynamic_rendering)',
      'Async Compute Queue Overlap', 'Shader SPIR-V Specialization Constants'
    ],
    failures: [
      'read-after-write (RAW) validation hazard on frame resource reuse', 'deadlock across graphic and compute queues due to cyclic semaphore waits',
      'exhaustion of maxMemoryAllocationCount limit by allocating individual VkDeviceMemory objects',
      'presentation tearing or frame jitter from un-synchronized swapchain acquisition',
      'descriptor set binding bottleneck during heavy draw-call scene rendering',
      'GPU device lost error (TDR) in lengthy ray-tracing acceleration structure builds',
      'excessive memory bandwidth writing G-buffer attachments out to VRAM',
      'frame stutter when compiling SPIR-V pipelines on the fly',
      'pipeline barrier covering overly broad stages (ALL_COMMANDS_BIT) causing complete GPU drain',
      'out-of-bounds array access in bindless texture array indexing'
    ],
    fixes: [
      'insert targeted VkMemoryBarrier2 specifying precise source and destination pipeline stages and access masks',
      'coordinate CPU and multi-GPU queues using monotonically increasing timeline semaphores',
      'manage all buffer and image memory allocations through Vulkan Memory Allocator (VMA) arenas',
      'synchronize frame presentation via dedicated imageAvailable and renderFinished binary semaphores',
      'transition to bindless rendering using descriptor indexing with partially-bound flag enabled',
      'build and update acceleration structures incrementally across multiple frames or compute queues',
      'keep G-buffer transient attachments in tile memory using input attachments within single render pass',
      'precompile pipeline cache objects (VkPipelineCache) and load cached binaries at application startup',
      'narrow barrier scope to specific resource subresources and adjacent pipeline stages',
      'clamp descriptor indices in shader code and verify physical device descriptor indexing limits'
    ]
  },
  {
    id: 25,
    key: 'mob_android',
    name: 'Mobile:Android',
    shardFile: 'shard_25_mob_android.sqlite',
    keywords: ['android', 'choreographer', 'vsync', 'surfaceview', 'ndk', 'jni', 'anr', 'wakelock', 'renderthread', 'lmk'],
    topics: [
      'SurfaceView Double Buffering Teardown', 'Choreographer VSYNC Frame Pacing', 'NDK JNI Boundary Reference Limits',
      'Vulkan HardwareBuffer Zero-Copy Interop', 'ANR Watchdog Thread Tracing', 'Battery Historian Wakelock Profiling',
      'Edge-to-Edge Display Insets', 'WorkManager Background Job Constraints', 'RenderThread Hardware Rendering Pipeline', 'Memory Trim & Low-Memory Killer (LMK)'
    ],
    failures: [
      'crash during activity recreation when background render thread draws to destroyed Surface',
      'frame drops and UI stutter (jank) caused by Choreographer callback taking > 16.6ms',
      'JNI local reference table overflow (512 entries) in tight native loops',
      'texture corruption when sharing AHardwareBuffer between OpenGL and Vulkan without sync fence',
      'Application Not Responding (ANR) dialog from performing disk IO or DB queries on main thread',
      'battery drain from unreleased partial wake locks in background service',
      'navigation bar and status bar clipping UI elements on Android 15 edge-to-edge layouts',
      'WorkManager tasks failing to execute under aggressive manufacturer battery optimization',
      'RenderThread GPU stalling due to un-cached Bitmap allocations in draw calls',
      'silent process death caused by Android Low Memory Killer (LMK) when exceeding memory threshold'
    ],
    fixes: [
      'synchronize render thread lifecycle with SurfaceHolder.Callback surfaceDestroyed using lock/semaphore',
      'offload heavy computation off Choreographer callback onto background thread pool with Handler posting',
      'call DeleteLocalRef inside JNI loops or explicitly expand table via EnsureLocalCapacity',
      'coordinate cross-API buffer access using EGLSyncKHR or VkSemaphore external sync primitives',
      'strictly enforce StrictMode policy and delegate database queries to Room / SQLite background coroutines',
      'replace wake locks with WorkManager expedited jobs and acquire wake locks with explicit timeout limits',
      'apply WindowInsetsCompat.setOnApplyWindowInsetsListener and consume system bar insets',
      'configure WorkManager constraints with NetworkType.CONNECTED and RequiresBatteryNotLow',
      'recycle Bitmaps and render complex vector paths into hardware-accelerated RenderNode display lists',
      'respond to onTrimMemory(TRIM_MEMORY_RUNNING_CRITICAL) by purging in-memory image caches'
    ]
  },
  {
    id: 26,
    key: 'mob_ios',
    name: 'Mobile:iOS',
    shardFile: 'shard_26_mob_ios.sqlite',
    keywords: ['ios', 'metal', 'swift', 'mach_kernel', 'gcd', 'autoreleasepool', 'uikit', 'swiftui', 'os_log', 'instruments'],
    topics: [
      'Metal Render Command Encoder Lifetime', 'Grand Central Dispatch (GCD) Thread Pool Starvation',
      'Autoreleasepool Memory Drain in Tight Loops', 'Swift Concurrency Actors & Reentrancy Hazards',
      'Mach Port Inter-Process Messaging', 'CADisplayLink 120Hz ProMotion Synchronization',
      'CoreData / SwiftData Context Concurrency', 'Jetsam Memory Pressure & High-Water Mark',
      'Unified Memory Tile-Based Deferred Rendering (TBDR)', 'Background Execution Tasks & Assertion Expiry'
    ],
    failures: [
      'memory spike crash caused by deferred deallocation in un-drained autorelease loops',
      'thread explosion in GCD dispatch queues blocking UI main thread',
      'data race and unexpected state mutation due to Swift actor reentrancy during await suspensions',
      'Metal command buffer creation overhead stuttering 120Hz ProMotion animation frame rate',
      'Mach port leak exhausting task port space and crashing daemon process',
      'silent Jetsam termination due to exceeding memory footprint limit in background extension',
      'CoreData crash caused by accessing managed objects from non-owning dispatch queue',
      'TBDR tile memory overflow caused by excessive active render target attachments',
      'app termination on expiration of background task assertion without calling endBackgroundTask',
      'layout thrashing caused by recursive SwiftUI body re-computations'
    ],
    fixes: [
      'wrap large iteration loops inside autoreleasepool { ... } blocks for instantaneous memory drainage',
      'limit concurrent GCD dispatching with DispatchSemaphore or migrate to Swift structured concurrency Tasks',
      'validate state invariants immediately following every suspension point across actor method boundaries',
      'encode Metal commands into reusable MTLIndirectCommandBuffer objects and pace via CADisplayLink',
      'clean up allocated Mach ports with mach_port_deallocate after completion of IPC calls',
      'monitor os_proc_available_memory() and respond aggressively to didReceiveMemoryWarning notifications',
      'access managed objects strictly via performBackgroundTask or modelContext.perform { ... }',
      'minimize attachment count and leverage Metal memoryless render targets for depth/stencil buffers',
      'register expiration handlers on beginBackgroundTask that cleanly cancel operations within 5 seconds',
      'break SwiftUI dependency cycles by extracting state into fine-grained Observable models'
    ]
  },
  {
    id: 27,
    key: 'db_sqlite',
    name: 'Databases:SQLite',
    shardFile: 'shard_27_db_sqlite.sqlite',
    keywords: ['sqlite', 'wal', 'fts5', 'btree', 'pragma', 'node_sqlite', 'vacuum', 'transactions', 'page_cache', 'checkpoint'],
    topics: [
      'Write-Ahead Logging (WAL) Mode Checkpointing', 'FTS5 Full-Text Search Tokenizer & BM25 Scoring',
      'B-Tree Page Size & Cache Size Calibration', 'Memory-Mapped I/O (PRAGMA mmap_size)',
      'Single-Writer Multi-Reader Lock Concurrency', 'Incremental VACUUM & Auto-Vacuum Modes',
      'Prepared Statement Caching & Query Planning', 'FTS5 External Content Tables & Sync Triggers',
      'Temp Store In-Memory Spilling', 'Atomic Commit & Write Durability (synchronous=NORMAL)'
    ],
    failures: [
      'WAL file unchecked growth to gigabytes due to open unfinalized read transactions',
      'database locked (SQLITE_BUSY) errors under concurrent multi-process writes',
      'point query performance degradation from unindexed foreign key lookups',
      'FTS5 index desynchronization when mutating parent table without trigger updates',
      'disk I/O thrashing during large queries falling back to disk-based temporary btrees',
      'page cache eviction storms during massive bulk insertions without transactions',
      'data corruption risk from setting synchronous=OFF on volatile hardware',
      'memory footprint explosion when setting mmap_size excessively on 32-bit processes',
      'high query compilation overhead from failing to cache prepared statements',
      'write amplification during table drops without auto_vacuum configuration'
    ],
    fixes: [
      'run PRAGMA wal_autocheckpoint=1000 and ensure all read statements are promptly finalized',
      'set PRAGMA busy_timeout=5000 and serialize write operations or use partitioned multi-file databases',
      'configure PRAGMA cache_size=-64000 (64MB) and PRAGMA page_size=4096 matching filesystem sectors',
      'enable PRAGMA mmap_size=268435456 (256MB) for direct memory-mapped read access',
      'construct FTS5 triggers (ai, ad, au) on content tables to maintain index synchronization atomically',
      'wrap bulk insertions inside explicit BEGIN TRANSACTION and COMMIT boundaries',
      'set PRAGMA synchronous=NORMAL for optimal performance with full WAL durability',
      'configure PRAGMA temp_store=MEMORY to keep temporary indices and sort operations in RAM',
      'reuse prepared statements across query cycles and use parameterized bindings strictly',
      'enable PRAGMA auto_vacuum=INCREMENTAL to reclaim storage space without full database locks'
    ]
  },
  {
    id: 28,
    key: 'db_vector',
    name: 'Databases:Vector_HNSW',
    shardFile: 'shard_28_db_vector.sqlite',
    keywords: ['vector', 'hnsw', 'embeddings', 'ann', 'cosine', 'product_quantization', 'ivf', 'similarity_search', 'rag'],
    topics: [
      'Hierarchical Navigable Small World (HNSW) Graph Construction', 'Product Quantization (PQ) Vector Compression',
      'M and efConstruction Hyperparameter Calibration', 'Cosine vs Euclidean L2 Distance Optimizations',
      'Inverted File Index (IVF-PQ) Partition Centroids', 'SIMD Distance Calculation Intrinsics (AVX-512)',
      'Vector Index Persistence & Memory-Mapping', 'Dynamic Graph Vertex Pruning & Shrinking',
      'Filtered Vector Search with Metadata Predicates', 'Dynamic Index Updates & Concurrent Insertion'
    ],
    failures: [
      'recall rate drops dramatically when efSearch parameter is configured too low',
      'memory exhaustion when storing high-dimensional uncompressed FP32 vectors in RAM',
      'graph connectivity fragmentation when deleting nodes in HNSW hierarchy',
      'slow query throughput from evaluating distance metrics on non-vectorized CPU instructions',
      'index build time explodes exponentially with overly large M and efConstruction settings',
      'filtered search degenerate performance when post-filtering highly restrictive metadata',
      'lock contention during concurrent graph insertion degrading real-time ingestion',
      'vector drift causing inaccurate clustering around static IVF centroids',
      'accuracy collapse in Product Quantization due to codebook training on non-representative samples',
      'cold start latency reading multi-gigabyte vector graphs into memory'
    ],
    fixes: [
      'tune efSearch dynamically based on required recall threshold (e.g. efSearch=64 for 98% recall)',
      'compress vectors using Scalar Quantization (SQ8) or Product Quantization (PQ) to reduce RAM by 4-8x',
      'maintain bidirectional graph links and repair entry points when pruning or deleting graph vertices',
      'implement AVX-512 / NEON vectorized dot product and L2 distance routines with runtime dispatch',
      'set M=16 to 32 and efConstruction=100 to 200 for optimal tradeoff between build time and accuracy',
      'employ single-stage pre-filtering with ACORN or iterated graph traversal with predicate constraints',
      'partition vector graph into multi-layer shards with lock-free node addition protocols',
      're-cluster IVF centroids periodically using online k-means over recent query distributions',
      'train PQ codebooks on stratified samples covering diverse semantic domains',
      'memory-map the HNSW graph file directly using madvise(MADV_WILLNEED) for rapid startup'
    ]
  },
  {
    id: 29,
    key: 'compilers_llvm',
    name: 'Compilers:LLVM',
    shardFile: 'shard_29_compilers_llvm.sqlite',
    keywords: ['llvm', 'ssa', 'ir', 'opt', 'vectorizer', 'clang', 'codegen', 'register_allocator', 'inlining', 'pass_manager'],
    topics: [
      'Static Single Assignment (SSA) Form Phis & Dominance', 'Loop Vectorizer & SLP Vectorization',
      'MemorySSA and Alias Analysis (AAManager)', 'Interprocedural Optimization (IPO) & Inliner Heuristics',
      'Instruction Selection (SelectionDAG & GlobalISel)', 'Register Allocation (Linear Scan vs Chaitin-Briggs)',
      'Target-Specific Machine Code Emission', 'Link-Time Optimization (ThinLTO / Full LTO)',
      'Undefined Behavior Exploitation & Optimization Hazards', 'Profile-Guided Optimization (PGO)'
    ],
    failures: [
      'compile time blowup caused by unbounded inline threshold in deeply nested templates',
      'vectorizer bailout due to ambiguous pointer aliasing in inner loop',
      'silent data corruption from optimizer assuming undefined behavior cannot occur',
      'register spilling in hot inner loops degrading compiled binary throughput',
      'broken SSA form after custom transform pass introducing dangling use of replaced instruction',
      'SelectionDAG legalizer failure on unsupported custom vector instruction types',
      'massive binary size bloat from aggressive loop unrolling and function cloning',
      'ThinLTO cross-module import graph thrashing linker memory',
      'inaccurate branch probabilities degrading PGO layout quality',
      'infinite pass manager loop caused by oscillating peephole optimizations'
    ],
    fixes: [
      'tune inline-threshold and apply __attribute__((always_inline)) selectively only on leaf routines',
      'annotate pointers with restrict or insert runtime alias checks (#pragma clang loop vectorize(assume_safety))',
      'compile with -fno-strict-aliasing and -fwrapv when optimizing legacy codebases',
      'schedule instructions to minimize register live ranges and assist Greedy Register Allocator',
      'verify IR validity with llvm::verifyFunction and llvm::verifyModule after every custom pass',
      'implement custom target lowering rules in TargetLowering::LowerOperation for non-native types',
      'constrain loop unroll factors with #pragma unroll 4 to balance code size and throughput',
      'configure ThinLTO import limits (thinlto-import-instr-limit) to bound memory during link stage',
      'collect representative profile traces using LLVM source-based code coverage (-fprofile-instr-generate)',
      'ensure all peephole transformations strictly decrease instruction cost metric to guarantee termination'
    ]
  },
  {
    id: 30,
    key: 'compilers_v8',
    name: 'Runtimes:V8_Turbofan',
    shardFile: 'shard_30_compilers_v8.sqlite',
    keywords: ['v8', 'turbofan', 'maglev', 'jit', 'deopt', 'hidden_classes', 'inline_cache', 'garbage_collection', 'scavenger', 'heap'],
    topics: [
      'Hidden Classes (Shapes) & Transition Trees', 'Inline Caching (Monomorphic vs Megamorphic)',
      'Turbofan Sea-of-Nodes Optimization Pipeline', 'Maglev Mid-Tier JIT Compilation',
      'Deoptimization Bailouts & Bailout Reasons', 'Orinoco Garbage Collector (Scavenger & Mark-Sweep)',
      'Array Storage Modes (Packed vs Holey, Smi vs Double)', 'Escape Analysis & Scalar Replacement',
      'WebAssembly Liftoff Baseline vs Turbofan Compilation', 'V8 Snapshot Serialization & Startup Warmup'
    ],
    failures: [
      'deoptimization loop triggered by mutating object properties in inconsistent orders',
      'inline cache degradation to megamorphic state causing 10x slowdown in hot function calls',
      'GC pauses (Stop-The-World) caused by old generation heap fragmentation and long mark times',
      'array mode transition from PACKED_SMI_ELEMENTS to HOLEY_ELEMENTS destroying JIT optimization',
      'memory leaks from retained closures keeping heavy parent scope contexts alive',
      'Turbofan compilation bailout due to overly complex control flow graphs',
      'high startup latency from parsing and compiling millions of lines of JavaScript',
      'unintended escape of temporary objects preventing scalar replacement in registers',
      'large object space (LOS) allocation spikes causing premature full garbage collection',
      'JIT code cache invalidation caused by dynamic script evaluation (eval/Function)'
    ],
    fixes: [
      'initialize all object properties in constructor in identical order to maintain stable hidden classes',
      'keep call sites monomorphic by passing objects with identical shapes to critical functions',
      'tune V8 heap parameters (--max-old-space-size, --semi-space-size) and minimize object allocations in hot paths',
      'initialize arrays with contiguous elements without skipping indices to retain PACKED_ELEMENTS modes',
      'nullify obsolete closure references and avoid retaining global lexical scope contexts',
      'decompose huge functions into modular, single-responsibility functions that fit Turbofan node budget',
      'utilize V8 startup snapshots (v8::SnapshotCreator) or bytecode caching to bypass cold parsing',
      'structure functions so temporary objects do not escape local scope, enabling scalar replacement',
      'avoid allocating objects larger than 128KB in tight loops to bypass the Large Object Space',
      'use static ES modules instead of dynamic code evaluation to allow persistent JIT code caching'
    ]
  },
  {
    id: 31,
    key: 'hardware_arch',
    name: 'Hardware:Architecture',
    shardFile: 'shard_31_hardware_arch.sqlite',
    keywords: ['hardware', 'numa', 'cpu_cache', 'mesi', 'branch_predictor', 'zen3', 'ipc', 'memory_bus', 'pcie4', 'nvme'],
    topics: [
      'Zen 3 / Zen 4 Core Complex Die (CCD) Latency', 'L1/L2/L3 Cache Hierarchy & MESI Protocol',
      'Branch Target Buffer (BTB) & TAGE Predictor', 'Hardware Prefetcher (L2 Stream & L1 Stride)',
      'Translation Lookaside Buffer (TLB) Page Misses', 'Memory Controller Infinity Fabric Bandwidth',
      'PCIe 4.0 NVMe Queue Depth Saturation', 'Store Buffer Forwarding & Memory Ordering',
      'Simultaneous Multithreading (SMT) Resource Sharing', 'AVX2 / AVX-512 Frequency Throttling'
    ],
    failures: [
      'inter-CCD communication latency penalty when threads migrate across Zen 3 CCX dies',
      'false sharing cache line bouncing invalidating MESI states across cores',
      'branch misprediction flush wasting 15-20 CPU execution cycles per branch',
      'TLB thrashing degrading performance on random memory access across large data heaps',
      'Infinity Fabric saturation bottlenecking memory throughput under 32-thread saturation',
      'underutilized NVMe SSD throughput due to queue depth 1 synchronous I/O operations',
      'store-to-load forwarding stall caused by overlapping unaligned memory access',
      'SMT resource contention where sibling thread starves primary execution units',
      'hardware prefetcher pollution caused by stride prefetcher triggering on random access',
      'thermal throttling reducing CPU core clock frequencies during sustained multi-core load'
    ],
    fixes: [
      'pin compute worker threads to specific cores within the same physical CCX using thread affinity masks',
      'pad shared concurrent variables with alignas(64) to ensure single cache line ownership',
      'structure hot branching code into branchless bitwise select routines or sort data to assist TAGE predictor',
      'use 2MB or 1GB huge pages to expand TLB reach and eliminate page table walk latency',
      'tune memory sub-timings and balance memory channels evenly to maximize Infinity Fabric bandwidth',
      'saturate PCIe NVMe controller by submitting parallel asynchronous I/O across 32+ queue depths',
      'align load and store operations to exact 4-byte / 8-byte boundaries matching word sizes',
      'assign compute-intensive worker loops to physical cores before assigning to logical SMT siblings',
      'traverse memory arrays in strictly sequential row-major order to maximize hardware prefetcher hit rates',
      'maintain optimal thermal dissipation curves and monitor CPU package power limits (PPT/TDC/EDC)'
    ]
  }
];

export function getDomainById(id: number): VaultDomain | undefined {
  return VAULT_DOMAINS.find(d => d.id === id);
}

export function routeQueryToDomainIds(query: string): number[] {
  const normalized = query.toLowerCase().replace(/[^a-z0-9_\s]/g, ' ');
  const words = normalized.split(/\s+/).filter(w => w.length >= 2);
  if (words.length === 0) return [];

  const scores = new Map<number, number>();
  for (const domain of VAULT_DOMAINS) {
    let score = 0;
    for (const word of words) {
      for (const kw of domain.keywords) {
        if (kw === word) score += 10;
        else if (kw.includes(word) || word.includes(kw)) score += 3;
      }
      for (const topic of domain.topics) {
        if (topic.toLowerCase().includes(word)) score += 2;
      }
    }
    if (score > 0) {
      scores.set(domain.id, score);
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(e => e[0]);
}
