const assert = require('assert');

// Copy RingBuffer here for now (since we don't use modules yet)
class RingBuffer {
    constructor(capacity) {
        this.capacity = capacity;
        this.buffer = new Array(capacity);
        this.head = 0;
        this.size = 0;
    }

    push(item) {
        const oldItem = this.buffer[this.head];
        this.buffer[this.head] = item;
        this.head = (this.head + 1) % this.capacity;
        this.size = Math.min(this.size + 1, this.capacity);
        return oldItem;
    }

    toArray() {
        if (this.size < this.capacity) {
            return this.buffer.slice(0, this.size);
        }
        return this.buffer.slice(this.head).concat(this.buffer.slice(0, this.head));
    }
}

function testCoverage() {
    const rb = new RingBuffer(5);

    // Empty
    assert.deepStrictEqual(rb.toArray(), [], "Empty buffer should return empty array");

    // Partially filled
    rb.push(10);
    rb.push(20);
    assert.deepStrictEqual(rb.toArray(), [10, 20], "Partially filled buffer should return items in order");

    // Full
    rb.push(30);
    rb.push(40);
    rb.push(50);
    assert.deepStrictEqual(rb.toArray(), [10, 20, 30, 40, 50], "Full buffer should return all items");

    // Wrap around
    rb.push(60);
    assert.deepStrictEqual(rb.toArray(), [20, 30, 40, 50, 60], "Wrap around should return items in correct order");

    // Overwrite and return old item
    const oldItem1 = rb.push(70); // head was 1, overwrites index 1 (which was 20)
    assert.strictEqual(oldItem1, 20, "push() should return the overwritten item");

    const oldItem2 = rb.push(80); // overwrites index 2 (which was 30)
    assert.strictEqual(oldItem2, 30, "push() should return the overwritten item");

    console.log("Extended RingBuffer tests passed.");
}

testCoverage();
