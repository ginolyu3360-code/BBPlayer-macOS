#include "AudioRealtime.h"
#include <AudioToolbox/AudioToolbox.h>
#include <math.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

enum { Bands = 10, Channels = 8 };
static const double centers[Bands] = {31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000};
static const double tau = 6.2831853071795864769;
typedef struct { double b0, b1, b2, a1, a2; } Biquad;
typedef struct { double z1, z2; } Delay;
struct BBEQ {
    _Atomic uint64_t published;
    _Atomic bool enabled;
    _Atomic double gains[Bands];
    _Atomic int status;
    uint64_t seen;
    double rate, smoothing, wet, targetWet, trim, targetTrim;
    size_t channels;
    Biquad current[Bands], target[Bands];
    Delay delay[Channels][Bands];
};

BBEQ *bb_eq_create(void) { return calloc(1, sizeof(BBEQ)); }
void bb_eq_destroy(BBEQ *eq) { free(eq); }

void bb_eq_configure(BBEQ *eq, bool enabled, const double *gains) {
    if (!eq || !gains) return;
    // A single control writer; the audio callback never waits for an update.
    atomic_fetch_add(&eq->published, 1);
    for (size_t i = 0; i < Bands; i++)
        atomic_store(&eq->gains[i], isfinite(gains[i]) ? fmax(-12, fmin(12, gains[i])) : 0);
    atomic_store(&eq->enabled, enabled);
    atomic_fetch_add(&eq->published, 1);
}

void bb_eq_prepare(BBEQ *eq, double sample_rate, size_t channels, bool float32) {
    if (!eq) return;
    eq->seen = UINT64_MAX;
    eq->rate = sample_rate;
    eq->channels = channels;
    eq->wet = eq->targetWet = 0;
    eq->trim = eq->targetTrim = 1;
    eq->smoothing = sample_rate > 0 ? 1 - exp(-1.0 / (sample_rate * 0.020)) : 0;
    memset(eq->delay, 0, sizeof(eq->delay));
    for (size_t i = 0; i < Bands; i++) eq->current[i] = eq->target[i] = (Biquad){1, 0, 0, 0, 0};
    atomic_store(&eq->status, float32 && channels > 0 && channels <= Channels && sample_rate >= 8000 && sample_rate <= 384000 ? 1 : -1);
}

int bb_eq_status(const BBEQ *eq) { return eq ? atomic_load(&eq->status) : 0; }

// Peaking filter coefficients from the W3C Audio EQ Cookbook:
// https://www.w3.org/TR/audio-eq-cookbook/#biquad-filter-formulae
static Biquad peaking(double frequency, double rate, double gain) {
    if (gain == 0 || frequency >= rate * 0.49) return (Biquad){1, 0, 0, 0, 0};
    double w = tau * frequency / rate, a = pow(10, gain / 40);
    double alpha = sin(w) / (2 * 1.4142135623730951), a0 = 1 + alpha / a;
    double middle = -2 * cos(w) / a0;
    return (Biquad){(1 + alpha * a) / a0, middle, (1 - alpha * a) / a0, middle, (1 - alpha / a) / a0};
}
static double response(const Biquad *filters, double angle) {
    double c = cos(angle), s = sin(angle), c2 = 2*c*c - 1, s2 = 2*s*c;
    double gain = 1;
    for (size_t i = 0; i < Bands; i++) {
        Biquad b = filters[i];
        double nr = b.b0 + b.b1*c + b.b2*c2, ni = b.b1*s + b.b2*s2;
        double dr = 1 + b.a1*c + b.a2*c2, di = b.a1*s + b.a2*s2;
        gain *= (nr*nr + ni*ni) / (dr*dr + di*di);
    }
    return gain;
}
static void read_update(BBEQ *eq) {
    uint64_t first = atomic_load(&eq->published);
    if ((first & 1) || first == eq->seen) return;
    bool enabled = atomic_load(&eq->enabled);
    double gains[Bands];
    for (size_t i = 0; i < Bands; i++) gains[i] = atomic_load(&eq->gains[i]);
    if (atomic_load(&eq->published) != first) return;
    eq->seen = first;
    bool nonflat = false;
    for (size_t i = 0; i < Bands; i++)
        nonflat |= gains[i] != 0 && centers[i] < eq->rate * 0.49;
    eq->targetWet = enabled && nonflat ? 1 : 0;
    if (eq->targetWet == 0) return; // Fade to dry while keeping the current filter response.
    for (size_t i = 0; i < Bands; i++) eq->target[i] = peaking(centers[i], eq->rate, gains[i]);
    double peak = 1;
    for (size_t i = 0; i <= 128; i++) {
        double frequency = 20 * pow(eq->rate * 0.49 / 20, (double)i / 128);
        peak = fmax(peak, response(eq->target, tau * frequency / eq->rate));
    }
    for (size_t i = 0; i < Bands; i++)
        if (centers[i] < eq->rate * 0.49) peak = fmax(peak, response(eq->target, tau * centers[i] / eq->rate));
    eq->targetTrim = peak > 1.001 ? 0.944060876 / sqrt(peak) : 1;
    if (eq->wet == 0) {
        memcpy(eq->current, eq->target, sizeof(eq->current));
        memset(eq->delay, 0, sizeof(eq->delay));
        eq->trim = eq->targetTrim;
    }
}
static void step(Biquad *b, Biquad t, double factor) {
    b->b0 += (t.b0 - b->b0)*factor; b->b1 += (t.b1 - b->b1)*factor;
    b->b2 += (t.b2 - b->b2)*factor; b->a1 += (t.a1 - b->a1)*factor;
    b->a2 += (t.a2 - b->a2)*factor;
}

void bb_eq_process(BBEQ *eq, void *audio_buffer_list, size_t frames) {
    if (!eq || !audio_buffer_list || !frames || bb_eq_status(eq) != 1) return;
    AudioBufferList *list = audio_buffer_list;
    if (list->mNumberBuffers == 0 || list->mNumberBuffers > Channels) return;
    float *data[Channels];
    size_t stride[Channels], channels = 0;
    for (size_t j = 0; j < list->mNumberBuffers; j++) {
        AudioBuffer *buffer = &list->mBuffers[j];
        size_t count = buffer->mNumberChannels;
        if (!buffer->mData || !count || channels + count > Channels ||
            frames > buffer->mDataByteSize / sizeof(float) / count) return;
        for (size_t i = 0; i < count; i++) {
            data[channels] = (float *)buffer->mData + i;
            stride[channels++] = count;
        }
    }
    if (channels != eq->channels) return;
    read_update(eq);
    if (eq->wet == 0 && eq->targetWet == 0) return; // Exact bypass.
    double smoothing = eq->smoothing;
    for (size_t frame = 0; frame < frames; frame++) {
        eq->wet += (eq->targetWet - eq->wet) * smoothing;
        eq->trim += (eq->targetTrim - eq->trim) * smoothing;
        for (size_t i = 0; i < Bands; i++) step(&eq->current[i], eq->target[i], smoothing);
        for (size_t channel = 0; channel < channels; channel++) {
            float *sample = data[channel] + frame * stride[channel];
            double input = *sample, value = input;
            if (!isfinite(input)) { *sample = 0; continue; }
            for (size_t i = 0; i < Bands; i++) {
                Biquad b = eq->current[i];
                Delay *delay = &eq->delay[channel][i];
                double next = b.b0 * value + delay->z1;
                delay->z1 = b.b1 * value - b.a1 * next + delay->z2;
                delay->z2 = b.b2 * value - b.a2 * next;
                value = next;
            }
            double mixed = input + (value * eq->trim - input) * eq->wet;
            *sample = isfinite(mixed) ? (float)mixed : 0;
        }
    }
    if (eq->targetWet == 0 && eq->wet < 0.001) eq->wet = 0;
}
