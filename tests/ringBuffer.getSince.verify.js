
/**
 * Test for RingBuffer.getSince implementation
 */

class RingBuffer {
    constructor(capacity) {
        this.capacity = capacity;
        this.buffer = new Array(capacity);
        this.head = 0;
        this.size = 0;
        this.totalPushed = 0;
    }

    push(item) {
        this.buffer[this.head] = item;
        this.head = (this.head + 1) % this.capacity;
        this.size = Math.min(this.size + 1, this.capacity);
        this.totalPushed++;
    }

    getSince(startSeq) {
        const count = this.totalPushed - startSeq;
        if (count <= 0) return [];
        
        const result = [];
        const available = Math.min(count, this.size);
        for (let i = 0; i < available; i++) {
            const idx = (this.head - available + i + this.capacity) % this.capacity;
            result.push(this.buffer[idx]);
        }
        return result;
    }
}

function test() {
    console.log("Starting RingBuffer.getSince verification...");
    
    const rb = new RingBuffer(5);

    // 1. Initial push
    rb.push("A"); // 1
    rb.push("B"); // 2
    rb.push("C"); // 3
    
    let res = rb.getSince(0);
    console.assert(res.length === 3, "Fail: Should get 3 items from 0");
    console.assert(res[0] === "A" && res[2] === "C", "Fail: Order mismatch 1");

    res = rb.getSince(1);
    console.assert(res.length === 2, "Fail: Should get 2 items from 1");
    console.assert(res[0] === "B" && res[1] === "C", "Fail: Order mismatch 2");

    // 2. Wrap around
    rb.push("D"); // 4
    rb.push("E"); // 5
    rb.push("F"); // 6 - wraps, 'A' gone
    
    res = rb.getSince(0);
    console.assert(res.length === 5, "Fail: Should cap at 5 items");
    console.assert(res[0] === "B", "Fail: Oldest item should be B (A was at seq 1)");
    console.assert(res[4] === "F", "Fail: Newest item should be F");

    res = rb.getSince(4);
    console.assert(res.length === 2, "Fail: Should get 2 items since seq 4 (E, F)");
    console.assert(res[0] === "E" && res[1] === "F", "Fail: E/F mismatch");

    // 3. Request far in past
    res = rb.getSince(-100);
    console.assert(res.length === 5, "Fail: Should cap at capacity even for old seq");

    // 4. Request current
    res = rb.getSince(6);
    console.assert(res.length === 0, "Fail: Should be empty for current seq");

    console.log("Verification COMPLETE. All assertions passed.");
}

test();
