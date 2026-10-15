#![no_std]

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! { loop {} }

// Input arrays are written into exported Wasm linear memory by the browser.
// The function folds temporal deltas into a bounded pixel grid and emits
// triples of f32 (x, y, cumulative weight).  Keeping this hot loop outside
// JS avoids millions of temporary objects during timeline playback.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn aggregate(
    cell_x: *const u16, cell_y: *const u16, delta_start: *const u32,
    delta_count: *const u16, delta_year: *const u16, delta_weight: *const f32,
    cell_count: u32, until: u16, factor: u32, width: u32, height: u32,
    buckets: *mut f32, bucket_width: u32, bucket_height: u32, output: *mut f32,
) -> u32 {
    let bucket_count = bucket_width * bucket_height;
    for index in 0..bucket_count { *buckets.add(index as usize) = 0.0; }
    for index in 0..cell_count {
        let start = *delta_start.add(index as usize);
        let count = *delta_count.add(index as usize) as u32;
        let mut weight = 0.0;
        for offset in start..start + count {
            if *delta_year.add(offset as usize) <= until { weight += *delta_weight.add(offset as usize); }
        }
        if weight <= 0.0 { continue; }
        let x = (*cell_x.add(index as usize) as u32) / factor;
        let y = (*cell_y.add(index as usize) as u32) / factor;
        *buckets.add((y * bucket_width + x) as usize) += weight;
    }
    let mut written = 0;
    for y in 0..bucket_height {
        for x in 0..bucket_width {
            let weight = *buckets.add((y * bucket_width + x) as usize);
            if weight <= 0.0 { continue; }
            let offset = (written * 3) as usize;
            *output.add(offset) = core::cmp::min(width - 1, x * factor + factor / 2) as f32;
            *output.add(offset + 1) = core::cmp::min(height - 1, y * factor + factor / 2) as f32;
            *output.add(offset + 2) = weight;
            written += 1;
        }
    }
    written
}
