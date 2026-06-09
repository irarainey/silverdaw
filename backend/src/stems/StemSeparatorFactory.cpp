#include "StemSeparator.h"

#if SILVERDAW_STEM_SEPARATION
#include "OnnxStemSeparator.h"
#endif

namespace silverdaw
{
namespace
{

// Fallback used in builds without stem separation compiled in. It fails fast so
// the renderer surfaces a clear, actionable STEM_FAILED instead of hanging.
class NullStemSeparator : public StemSeparator
{
  public:
    StemSeparationResult separate(const StemSeparationRequest&,
                                  const StemProgressFn&,
                                  const StemReadyFn&,
                                  const StemCancelFn&) override
    {
        throw StemSeparationError(StemFailureCode::Model,
                                  "Stem separation is not available in this build.");
    }
};

} // namespace

std::unique_ptr<StemSeparator> createDefaultStemSeparator()
{
#if SILVERDAW_STEM_SEPARATION
    return makeOnnxStemSeparator();
#else
    return std::make_unique<NullStemSeparator>();
#endif
}

} // namespace silverdaw
