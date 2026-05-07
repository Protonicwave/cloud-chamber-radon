const assert = require('assert');

class RingBuffer {
    constructor(capacity) {
        this.capacity = capacity;
        this.buffer = new Array(capacity);
        this.head = 0;
        this.size = 0;
    }

    push(item) {
        this.buffer[this.head] = item;
        this.head = (this.head + 1) % this.capacity;
        this.size = Math.min(this.size + 1, this.capacity);
    }

    toArray() {
        if (this.size < this.capacity) {
            return this.buffer.slice(0, this.size);
        }
        return this.buffer.slice(this.head).concat(this.buffer.slice(0, this.head));
    }
}

const rb = new RingBuffer(3);
rb.push(1);
rb.push(2);
rb.push(3);
rb.push(4);
assert.deepStrictEqual(rb.toArray(), [2, 3, 4], "RingBuffer should overwrite oldest items");
console.log("RingBuffer test passed.");
