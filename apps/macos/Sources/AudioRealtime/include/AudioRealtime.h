#ifndef BBPLAYER_AUDIO_REALTIME_H
#define BBPLAYER_AUDIO_REALTIME_H
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
typedef struct BBPCM BBPCM;
BBPCM *bb_pcm_create(void);
void bb_pcm_retain(BBPCM *buffer);
void bb_pcm_destroy(BBPCM *buffer);
void bb_pcm_enable(BBPCM *buffer, bool enabled);
void bb_pcm_set_format(BBPCM *buffer, bool float32);
void bb_pcm_push(BBPCM *buffer, const float *samples, size_t frames, size_t stride);
size_t bb_pcm_read(BBPCM *buffer, float *destination, size_t count);
uint64_t bb_pcm_frames(BBPCM *buffer);
typedef struct BBEQ BBEQ;
BBEQ *bb_eq_create(void);
void bb_eq_destroy(BBEQ *eq);
void bb_eq_configure(BBEQ *eq, bool enabled, const double *gains);
void bb_eq_prepare(BBEQ *eq, double sample_rate, size_t channels, bool float32);
int bb_eq_status(const BBEQ *eq);
void bb_eq_process(BBEQ *eq, void *audio_buffer_list, size_t frames);
#endif
